import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";

import { describe, test, expect, afterEach } from "vitest";

import { SshAgentRelay } from "../local";
import { getTestTimeout, initMocks } from "../../../tests/common";
import type { SpawnedProcess } from "../../../common/ctx/execCtx";
import {
    CHANNEL_OFFSET,
    FrameType,
    HEADER_SIZE,
    LENGTH_OFFSET,
    TYPE_OFFSET,
} from "../remote";

initMocks();

const SOCK_PATH = `/tmp/relay-test-${process.pid}.sock`;
const AGENT_SOCK_PATH = `/tmp/relay-test-agent-${process.pid}.sock`;

interface Frame {
    type: FrameType,
    chan: number,
    payload: Buffer | null,
}

function localReadFrames(buf: Buffer): { frames: Frame[], remainder: Buffer } {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset + HEADER_SIZE <= buf.length) {
        const type = buf.readUInt16BE(offset + TYPE_OFFSET) as FrameType;
        const chan = buf.readUInt32BE(offset + CHANNEL_OFFSET);
        const len = buf.readUInt32BE(offset + LENGTH_OFFSET);
        if (offset + HEADER_SIZE + len > buf.length) { break; }

        const payload = len > 0
            ? Buffer.from(buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + len))
            : null;

        frames.push({ type, chan, payload });
        offset += HEADER_SIZE + len;
    }
    return { frames, remainder: Buffer.from(buf.subarray(offset)) };
}

function localWriteFrame(stream: NodeJS.WritableStream, type: FrameType, chan: number, data: Buffer | null) {
    const hdr = Buffer.alloc(HEADER_SIZE);
    hdr.writeUInt16BE(type, TYPE_OFFSET);
    hdr.writeUInt32BE(chan, CHANNEL_OFFSET);
    hdr.writeUInt32BE(data ? data.length : 0, LENGTH_OFFSET);
    stream.write(hdr);
    if (data && data.length > 0) { stream.write(data); }
}

function waitForFrames(proc: childProcess.ChildProcess, count: number, timeoutMs = 2000): Promise<Frame[]> {
    return new Promise((resolve, reject) => {
        const frames: Frame[] = [];
        let buf: Buffer = Buffer.alloc(0);
        const timer = setTimeout(() => {
            reject(new Error(`timeout waiting for ${count} frames, got ${frames.length}: ${JSON.stringify(frames)}`));
        }, timeoutMs);

        if (!proc.stdout) { throw new Error("proc.stdout is null"); }
        proc.stdout.on("data", (d: Buffer) => {
            buf = Buffer.concat([buf, d]);
            const result = localReadFrames(buf);
            frames.push(...result.frames);
            buf = result.remainder;
            if (frames.length >= count) {
                clearTimeout(timer);
                resolve(frames.slice(0, count));
            }
        });
    });
}

function spawnBridge(opts?: { disableNodeSafety?: boolean }): childProcess.ChildProcess {
    const REMOTE_SCRIPT = path.resolve(__dirname, "..", "remote.ts");
    const script = fs.readFileSync(REMOTE_SCRIPT, "utf-8") + "\nmain();";

    const nodeArgs = [
        "--input-type=module-typescript",
        "-e", script,
        "--",
        `--sock-path=${SOCK_PATH}`,
        (opts?.disableNodeSafety ? "--disable-node-safety" : ""),
    ];

    return childProcess.spawn("node", nodeArgs, {
        stdio: ["pipe", "pipe", "pipe"],
    });
}

function createFakeAgent(): Promise<net.Server> {
    return new Promise((resolve) => {
        try { fs.unlinkSync(AGENT_SOCK_PATH); }
        catch { }
        const server = net.createServer((sock) => {
            sock.on("data", (d) => {
                // echo back with a prefix
                sock.write(Buffer.concat([Buffer.from("AGENT:"), d]));
            });
        });
        server.listen(AGENT_SOCK_PATH, () => { resolve(server); });
    });
}

let bridge: childProcess.ChildProcess | undefined;
let agentServer: net.Server | undefined;

afterEach(() => {
    bridge?.kill();
    bridge = undefined;
    agentServer?.close();
    agentServer = undefined;
    try { fs.unlinkSync(SOCK_PATH); }
    catch { }
    try { fs.unlinkSync(AGENT_SOCK_PATH); }
    catch { }
});

describe("exec-pipe relay", () => {
    test("sanity", () => {
        // if this changes, then ensure correct handling of [0, 3]
        expect(FrameType.LAST).eq(4);

        // if this changes, then type field needs to be 3
        expect(FrameType.MAX).eq(15);
    }, getTestTimeout(10));

    test("bridge sends Ready frame on startup", async () => {
        bridge = spawnBridge();
        const frames = await waitForFrames(bridge, 1);
        expect(frames[0].type).toBe(FrameType.Ready);
        expect(frames[0].chan).toBe(0);
    }, getTestTimeout(10));

    test("bridge sends Open frame when client connects to socket", async () => {
        bridge = spawnBridge();
        const [ready] = await waitForFrames(bridge, 1);
        expect(ready.type).toBe(FrameType.Ready);

        // connect to the bridge's socket
        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>((resolve) => { client.on("connect", resolve); });

        const frames = await waitForFrames(bridge, 1);
        expect(frames[0].type).toBe(FrameType.Open);

        client.destroy();
    }, getTestTimeout(10));

    test("bridge forwards data from client to stdout", async () => {
        bridge = spawnBridge();
        await waitForFrames(bridge, 1); // Ready

        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>((resolve) => { client.on("connect", resolve); });

        const [open] = await waitForFrames(bridge, 1);
        expect(open.type).toBe(FrameType.Open);
        const chan = open.chan;

        client.write(Buffer.from("hello"));

        const [data] = await waitForFrames(bridge, 1);
        expect(data.type).toBe(FrameType.Data);
        expect(data.chan).toBe(chan);
        expect(data.payload).not.toBeNull();
        expect(data.payload?.toString()).toBe("hello");

        client.destroy();
    }, getTestTimeout(10));

    test("bridge forwards data from stdin to client", async () => {
        bridge = spawnBridge();
        await waitForFrames(bridge, 1); // Ready

        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>((resolve) => { client.on("connect", resolve); });

        const [open] = await waitForFrames(bridge, 1);
        const chan = open.chan;

        const clientData = new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => { reject(new Error("timeout waiting for client data")); }, 2000);
            client.once("data", (d) => {
                clearTimeout(timer);
                resolve(d);
            });
        });

        if (!bridge.stdin) { throw new Error("bridge.stdin is null"); }
        localWriteFrame(bridge.stdin, FrameType.Data, chan, Buffer.from("world"));

        const received = await clientData;
        expect(received.toString()).toBe("world");

        client.destroy();
    }, getTestTimeout(10));

    test("full roundtrip through fake agent", async () => {
        agentServer = await createFakeAgent();
        bridge = spawnBridge();
        await waitForFrames(bridge, 1); // Ready

        // client connects to bridge socket (simulates ssh-add inside container)
        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>((resolve) => { client.on("connect", resolve); });

        const [open] = await waitForFrames(bridge, 1);
        const chan = open.chan;

        // client sends data -> bridge stdout -> we read Open+Data frames
        client.write(Buffer.from("list-keys"));

        const [dataFrame] = await waitForFrames(bridge, 1);
        expect(dataFrame.type).toBe(FrameType.Data);
        expect(dataFrame.payload?.toString()).toBe("list-keys");

        // simulate host side: forward to real agent, get response, send back
        const agentConn = net.createConnection(AGENT_SOCK_PATH);
        await new Promise<void>((resolve) => { agentConn.on("connect", resolve); });

        const agentResponse = new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => { reject(new Error("timeout waiting for agent response")); }, 2000);
            agentConn.once("data", (d) => {
                clearTimeout(timer);
                resolve(d);
            });
        });

        agentConn.write(dataFrame.payload ?? Buffer.alloc(0));
        const response = await agentResponse;
        expect(response.toString()).toBe("AGENT:list-keys");

        // send response back through bridge stdin -> bridge socket -> client
        const clientResponse = new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => { reject(new Error("timeout waiting for client response")); }, 2000);
            client.once("data", (d) => {
                clearTimeout(timer);
                resolve(d);
            });
        });

        if (!bridge.stdin) { throw new Error("bridge.stdin is null"); }
        localWriteFrame(bridge.stdin, FrameType.Data, chan, response);

        const finalResponse = await clientResponse;
        expect(finalResponse.toString()).toBe("AGENT:list-keys");

        agentConn.destroy();
        client.destroy();
    }, getTestTimeout(10));

    test("bridge sends Close frame when client disconnects", async () => {
        bridge = spawnBridge();
        await waitForFrames(bridge, 1); // Ready

        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>((resolve) => { client.on("connect", resolve); });

        await waitForFrames(bridge, 1); // Open

        client.destroy();

        const [close] = await waitForFrames(bridge, 1);
        expect(close.type).toBe(FrameType.Close);
    }, getTestTimeout(10));
});

describe("stability edge-cases", () => {
    test("ready rejects when bridge exits before 'FrameType.Ready'", async () => {
        let exitCb: ((code: number | null) => void) | undefined;

        const mockProc: SpawnedProcess = {
            stdin: { write() { }, end() { } },
            onStdout() { },
            onStderr() { },
            onError() { },
            onExit(cb) { exitCb = cb; },
            onClose() { },
        };

        const relay = new SshAgentRelay(mockProc, "/tmp/fake-agent.sock", "/tmp/fake.sock");

        // bridge dies before sending Ready
        exitCb?.(1);

        const result = await Promise.race([
            relay.ready.then(() => "resolved").catch(() => "rejected"),
            new Promise<string>(r => setTimeout(() => { r("hung"); }, 500)),
        ]);

        // ready promise never rejects = it hangs forever
        expect(result).toBe("rejected");

        relay.dispose();
    });

    test("closeClient sends exactly one 'FrameType.Close' per disconnect", async () => {
        bridge = spawnBridge({ disableNodeSafety: true });

        const allFrames: Frame[] = [];
        let parseBuf: Buffer = Buffer.alloc(0);

        const onData = (d: Buffer) => {
            parseBuf = Buffer.concat([parseBuf, d]);
            const result = localReadFrames(parseBuf);
            allFrames.push(...result.frames);
            parseBuf = result.remainder;
        };

        if (!bridge.stdout) { throw new Error("bridge.stdout is null"); }
        bridge.stdout.on("data", onData);

        // wait for Ready
        while (!allFrames.some(f => f.type === FrameType.Ready)) {
            await new Promise(r => setTimeout(r, 10));
        }

        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>(r => client.on("connect", r));

        // wait for Open
        while (!allFrames.some(f => f.type === FrameType.Open)) {
            await new Promise(r => setTimeout(r, 10));
        }

        const openFrame = allFrames.find(f => f.type === FrameType.Open);
        if (!openFrame) { throw new Error("no Open frame"); }
        const chan = openFrame.chan;

        // flood data from host->bridge->client socket to fill the socket buffer
        // bridge will queue sock.write() calls and when client is destroyed,
        // pending writes fail (EPIPE) = error event = closeClient called
        if (!bridge.stdin) { throw new Error("bridge.stdin is null"); }
        const payload = Buffer.alloc(65536, 0x42);
        for (let i = 0; i < 100; i++) {
            localWriteFrame(bridge.stdin, FrameType.Data, chan, payload);
        }

        // don't read on client side — let bridge-side socket buffer fill
        await new Promise(r => setTimeout(r, 100));

        // half-close first -> bridge gets 'end' -> closeClient -> Close #1
        client.end();

        // wait for bridge to process the FIN
        await new Promise(r => setTimeout(r, 50));

        // full-close -> pending writes fail -> ECONNRESET -> 'error' -> closeClient -> Close #2
        client.destroy();

        // collect frames for 1s
        await new Promise(r => setTimeout(r, 1000));
        bridge.stdout.removeListener("data", onData);

        // potential bug: both 'end' and 'error' fire on bridge-side socket = two Close frames
        const closeFrames = allFrames.filter(f => f.type === FrameType.Close && f.chan === chan);
        expect(closeFrames).toHaveLength(1);
    });

    test("bridge destroys server-side socket on client disconnect", async () => {
        bridge = spawnBridge({ disableNodeSafety: true });
        await waitForFrames(bridge, 1); // Ready

        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>(r => client.on("connect", r));
        await waitForFrames(bridge, 1); // Open

        // register listener before triggering events to avoid race
        const clientClosed = new Promise<boolean>((r) => {
            const timer = setTimeout(() => { r(false); }, 1000);
            client.on("close", () => {
                clearTimeout(timer);
                r(true);
            });
        });

        // client half-closes (sends FIN to bridge)
        client.end();

        // bridge receives 'end' -> closeClient -> sends Close frame, deletes from map
        // potential bug: closeClient does not call sock.destroy(), so bridge-side socket
        // stays open (writable). Client never receives FIN from bridge.
        await waitForFrames(bridge, 1); // Close

        // if bridge properly destroyed its socket, client receives close event
        expect(await clientClosed).toBe(true);
    });
});
