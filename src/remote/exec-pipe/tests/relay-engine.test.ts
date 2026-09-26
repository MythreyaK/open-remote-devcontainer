import * as net from "net";
import * as fs from "fs";
import * as childProcess from "child_process";
import path from "node:path";

import { describe, test, expect, afterAll, afterEach } from "vitest";

import { getMockSettings, getTestTimeout, initMocks } from "../../../tests/common";
import { run } from "../../../common/cmd";

import { SshAgentRelay, SSH_AGENT_SOCK_DIR } from "../local";

initMocks();

const SETTINGS = getMockSettings();
const CONTAINER_IMAGE = "node:24-slim";

const SSH_RELAY_SCRIPT_LOCATION = path.join(__dirname, "../remote.ts");
const CONTAINER_NAME = `ord-relay-test-${process.pid}`;
const AGENT_SOCK_PATH = `/tmp/relay-engine-agent-${process.pid}.sock`;
const CONTAINER_SOCK_PATH = `${SSH_AGENT_SOCK_DIR}/test-${process.pid}.sock`;

function readBridgeScript(): string {
    return fs.readFileSync(SSH_RELAY_SCRIPT_LOCATION, "utf-8")
        .replace("${SSH_AGENT_SOCK_PATH}", CONTAINER_SOCK_PATH)
        .replace("${EXTENSION_ID}", "relay-engine-test")
        + "\nmain();";
}

function createFakeAgent(): Promise<net.Server> {
    return new Promise((resolve) => {
        try { fs.unlinkSync(AGENT_SOCK_PATH); }
        catch { }
        const server = net.createServer((sock) => {
            sock.on("data", (d) => {
                sock.write(Buffer.concat([Buffer.from("AGENT:"), d]));
            });
        });
        server.listen(AGENT_SOCK_PATH, () => { resolve(server); });
    });
}

function startBridge(engine: string): childProcess.ChildProcess {
    const bridgeScript = readBridgeScript();
    return childProcess.spawn(engine, [
        "exec", "-i", CONTAINER_NAME,
        "node", "--input-type=module-typescript", "-e", bridgeScript,
    ], {
        stdio: ["pipe", "pipe", "pipe"],
    });
}

async function waitForRelay(r: SshAgentRelay, timeoutMs = 15_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
        r.ready.then(() => { clearTimeout(timer); }),
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(new Error("bridge startup timeout")); }, timeoutMs);
        }),
    ]);
}

// client script that runs inside the container, connects to the bridge socket,
// sends a message, waits for one response, prints it to stdout
function clientScript(id: number): string {
    return [
        "import net from \"net\";",
        "const timer = setTimeout(() => { process.stderr.write(\"timeout\"); process.exit(1); }, 10000);",
        `const sock = net.createConnection("${CONTAINER_SOCK_PATH}", () => {`,
        `    sock.write("ping-${id}");`,
        "});",
        "sock.once(\"data\", (d) => {",
        "    clearTimeout(timer);",
        "    process.stdout.write(d.toString());",
        "    sock.destroy();",
        "});",
        "sock.on(\"error\", (e) => {",
        "    clearTimeout(timer);",
        "    process.stderr.write(e.message);",
        "    process.exit(1);",
        "});",
    ].join("\n");
}

let agentServer: net.Server | undefined;
let relay: SshAgentRelay | undefined;

describe.skipIf(!SETTINGS.dockerPath)("exec-pipe engine integration", () => {
    const engine = SETTINGS.dockerPath;

    afterAll(async () => {
        relay?.dispose();
        relay = undefined;
        agentServer?.close();
        agentServer = undefined;
        try { fs.unlinkSync(AGENT_SOCK_PATH); }
        catch { }
        await run([engine, "container", "stop", "-t", "2", CONTAINER_NAME], {});
        await run([engine, "container", "rm", "--force", CONTAINER_NAME], {});
    });

    afterEach(async () => {
        relay?.dispose();
        relay = undefined;
        agentServer?.close();
        agentServer = undefined;
        await run([engine, "exec", CONTAINER_NAME, "rm", "-f", CONTAINER_SOCK_PATH], {});
    });

    test("start container", async () => {
        const result = await run([
            engine, "run", "-d",
            "--name", CONTAINER_NAME,
            "--entrypoint", "/bin/sh",
            CONTAINER_IMAGE,
            "-c", 'trap "exit 0" SIGINT SIGTERM; while sleep 60 & wait $! ; do : ; done',
        ], {});
        expect(result.exit).toBe(0);
    }, getTestTimeout(60));

    test("100 concurrent clients through container relay", async () => {
        agentServer = await createFakeAgent();
        const proc = startBridge(engine);
        relay = new SshAgentRelay(proc, AGENT_SOCK_PATH, CONTAINER_SOCK_PATH);
        await waitForRelay(relay);

        const NUM_CLIENTS = 100;

        const results = await Promise.all(
            Array.from({ length: NUM_CLIENTS }, async (_, i) => {
                const r = await run([
                    engine, "exec", CONTAINER_NAME,
                    "node", "--input-type=module-typescript",
                    "-e", clientScript(i),
                ], {});
                return { i, exit: r.exit, stdout: r.stdout, stderr: r.stderr };
            }),
        );

        for (const r of results) {
            expect(r.exit, `client ${r.i} failed: ${r.stderr}`).toBe(0);
            expect(r.stdout).toBe(`AGENT:ping-${r.i}`);
        }
    }, getTestTimeout(120));

    test("sequential rapid connect/disconnect", async () => {
        agentServer = await createFakeAgent();
        const proc = startBridge(engine);
        relay = new SshAgentRelay(proc, AGENT_SOCK_PATH, CONTAINER_SOCK_PATH);
        await waitForRelay(relay);

        for (let i = 0; i < 50; i++) {
            const r = await run([
                engine, "exec", CONTAINER_NAME,
                "node", "--input-type=module-typescript",
                "-e", clientScript(i),
            ], {});
            expect(r.exit, `client ${i} failed: ${r.stderr}`).toBe(0);
            expect(r.stdout).toBe(`AGENT:ping-${i}`);
        }
    }, getTestTimeout(120));
});
