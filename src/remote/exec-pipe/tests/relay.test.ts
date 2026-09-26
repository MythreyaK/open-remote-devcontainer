import { describe, test, expect, afterEach } from "vitest";
import * as net from "net";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

const REMOTE_SCRIPT = path.resolve(__dirname, "..", "remote.ts");
const SOCK_PATH = `/tmp/relay-test-${process.pid}.sock`;
const AGENT_SOCK_PATH = `/tmp/relay-test-agent-${process.pid}.sock`;

const TYPE_SIZE = 2;
const CHAN_SIZE = 4;
const LEN_SIZE = 4;
const HEADER_SIZE = TYPE_SIZE + CHAN_SIZE + LEN_SIZE;
const TYPE_OFFSET = 0;
const CHANNEL_OFFSET = TYPE_OFFSET + TYPE_SIZE;
const LENGTH_OFFSET = CHANNEL_OFFSET + CHAN_SIZE;

const FrameType = { Ready: 0, Open: 1, Data: 2, Close: 3 } as const;
type FrameType = (typeof FrameType)[keyof typeof FrameType];

function writeFrame(stream: NodeJS.WritableStream, type: FrameType, chan: number, data: Buffer | null) {
    const hdr = Buffer.alloc(HEADER_SIZE);
    hdr.writeUInt16BE(type, TYPE_OFFSET);
    hdr.writeUInt32BE(chan, CHANNEL_OFFSET);
    hdr.writeUInt32BE(data ? data.length : 0, LENGTH_OFFSET);
    stream.write(hdr);
    if (data && data.length > 0) { stream.write(data); }
}

interface Frame {
    type: FrameType,
    chan: number,
    payload: Buffer | null,
}

function readFrames(buf: Buffer): { frames: Frame[], remainder: Buffer } {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset + HEADER_SIZE <= buf.length) {
        const type = buf.readUInt16BE(offset + TYPE_OFFSET) as FrameType;
        const chan = buf.readUInt32BE(offset + CHANNEL_OFFSET);
        const len = buf.readUInt32BE(offset + LENGTH_OFFSET);
        if (offset + HEADER_SIZE + len > buf.length) { break; }
        const payload = len > 0 ? Buffer.from(buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + len)) : null;
        frames.push({ type, chan, payload });
        offset += HEADER_SIZE + len;
    }
    return { frames, remainder: Buffer.from(buf.subarray(offset)) };
}

function waitForFrames(proc: childProcess.ChildProcess, count: number, timeoutMs = 5000): Promise<Frame[]> {
    return new Promise((resolve, reject) => {
        const frames: Frame[] = [];
        let buf: Buffer = Buffer.alloc(0);
        const timer = setTimeout(() => {
            reject(new Error(`timeout waiting for ${count} frames, got ${frames.length}: ${JSON.stringify(frames)}`));
        }, timeoutMs);

        if (!proc.stdout) { throw new Error("proc.stdout is null"); }
        proc.stdout.on("data", (d: Buffer) => {
            buf = Buffer.concat([buf, d]);
            const result = readFrames(buf);
            frames.push(...result.frames);
            buf = result.remainder;
            if (frames.length >= count) {
                clearTimeout(timer);
                resolve(frames.slice(0, count));
            }
        });
    });
}

function spawnBridge(): childProcess.ChildProcess {
    const script = fs.readFileSync(REMOTE_SCRIPT, "utf-8")
        .replace("${SSH_AGENT_SOCK_PATH}", SOCK_PATH)
        .replace("${EXTENSION_ID}", "test-relay")
        + "\nmain();";

    return childProcess.spawn("node", ["--input-type=module-typescript", "-e", script], {
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
    test("bridge sends Ready frame on startup", async () => {
        bridge = spawnBridge();
        const frames = await waitForFrames(bridge, 1);
        expect(frames[0].type).toBe(FrameType.Ready);
        expect(frames[0].chan).toBe(0);
    }, 10_000);

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
    }, 10_000);

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
    }, 10_000);

    test("bridge forwards data from stdin to client", async () => {
        bridge = spawnBridge();
        await waitForFrames(bridge, 1); // Ready

        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>((resolve) => { client.on("connect", resolve); });

        const [open] = await waitForFrames(bridge, 1);
        const chan = open.chan;

        const clientData = new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => { reject(new Error("timeout waiting for client data")); }, 5000);
            client.once("data", (d) => {
                clearTimeout(timer);
                resolve(d);
            });
        });

        if (!bridge.stdin) { throw new Error("bridge.stdin is null"); }
        writeFrame(bridge.stdin, FrameType.Data, chan, Buffer.from("world"));

        const received = await clientData;
        expect(received.toString()).toBe("world");

        client.destroy();
    }, 10_000);

    test("full roundtrip through fake agent", async () => {
        agentServer = await createFakeAgent();
        bridge = spawnBridge();
        await waitForFrames(bridge, 1); // Ready

        // client connects to bridge socket (simulates ssh-add inside container)
        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>((resolve) => { client.on("connect", resolve); });

        const [open] = await waitForFrames(bridge, 1);
        const chan = open.chan;

        // client sends data → bridge stdout → we read Open+Data frames
        client.write(Buffer.from("list-keys"));

        const [dataFrame] = await waitForFrames(bridge, 1);
        expect(dataFrame.type).toBe(FrameType.Data);
        expect(dataFrame.payload?.toString()).toBe("list-keys");

        // simulate host side: forward to real agent, get response, send back
        const agentConn = net.createConnection(AGENT_SOCK_PATH);
        await new Promise<void>((resolve) => { agentConn.on("connect", resolve); });

        const agentResponse = new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => { reject(new Error("timeout waiting for agent response")); }, 5000);
            agentConn.once("data", (d) => {
                clearTimeout(timer);
                resolve(d);
            });
        });

        agentConn.write(dataFrame.payload ?? Buffer.alloc(0));
        const response = await agentResponse;
        expect(response.toString()).toBe("AGENT:list-keys");

        // send response back through bridge stdin → bridge socket → client
        const clientResponse = new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => { reject(new Error("timeout waiting for client response")); }, 5000);
            client.once("data", (d) => {
                clearTimeout(timer);
                resolve(d);
            });
        });

        if (!bridge.stdin) { throw new Error("bridge.stdin is null"); }
        writeFrame(bridge.stdin, FrameType.Data, chan, response);

        const finalResponse = await clientResponse;
        expect(finalResponse.toString()).toBe("AGENT:list-keys");

        agentConn.destroy();
        client.destroy();
    }, 15_000);

    test("bridge sends Close frame when client disconnects", async () => {
        bridge = spawnBridge();
        await waitForFrames(bridge, 1); // Ready

        const client = net.createConnection(SOCK_PATH);
        await new Promise<void>((resolve) => { client.on("connect", resolve); });

        await waitForFrames(bridge, 1); // Open

        client.destroy();

        const [close] = await waitForFrames(bridge, 1);
        expect(close.type).toBe(FrameType.Close);
    }, 10_000);
});
