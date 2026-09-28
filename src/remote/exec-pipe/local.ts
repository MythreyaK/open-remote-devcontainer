import * as net from "net";
import path from "node:path";

import { randomUUID } from "node:crypto";
import { getLogSink } from "../../extension/log";
import { EXTENSION_ID } from "../../common/constants";
import type { SpawnedProcess } from "../../common/ctx/execCtx";

import {
    FrameType,
    HEADER_SIZE,
    TYPE_OFFSET,
    CHANNEL_OFFSET,
    LENGTH_OFFSET,
} from "./remote";

// Location of socket in container.
export const SSH_AGENT_SOCK_DIR = `/tmp/codium-${EXTENSION_ID}-ipc`;

export function sshAgentSockPath(): string {
    return path.posix.join(SSH_AGENT_SOCK_DIR, `ssh-agent-fwd-${randomUUID()}.sock`);
}

function getMsg(msg: string) {
    return `[ssh-agent-relay/host]: ${msg}`;
}

/**
 * We create a relay per-window, so stale sockets might accumulate
 * but that's more reliable as we won't have to maintain state
 * that's not tied to window lifetime. Using a socket that's tied
 * to the container lifecycle is a lil more painful, especially for
 * devcontainers over ssh.
 *
 * For a remote over SSH, we exec over the ssh connection via the
 * SSH-extension's execServer provider, so the connection lifetime
 * is necessarily bound to the window, meaning we can't exec a
 * forwarded "outside" the window's lifetime, unlike in local case.
 * So just use window-bound lifetime for all sockets for consistency.
 * Also prevents buggy cases with unstable connections.
 *
 * local.ts is the workspace-local relay-end that connects to the
 * socket. "workspace-local" on a remote-ssh machine = on the remote
 * ssh machine. Uses docker exec and shuttles data over stdin/stdout
 * to the socket in the container. The container-side listener is
 * in remote.ts.
 *
**/
export class SshAgentRelay {
    private readonly agentConns = new Map<number, net.Socket>();
    private inBuf = Buffer.alloc(0);
    private disposed = false;
    private readyResolve: (() => void) | undefined;
    private readyReject: ((err: Error) => void) | undefined;
    readonly ready: Promise<void>;

    constructor(
        private readonly proc: SpawnedProcess,
        private readonly sshAuthSock: string,
        readonly containerSockPath: string,
    ) {
        this.ready = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });

        proc.onStdout((d) => { this.onData(d); });
        proc.onStderr((d) => {
            getLogSink().info(getMsg(d.toString().trim()));
        });
        proc.onExit((code) => {
            if (!this.disposed) {
                getLogSink().warn(getMsg(`bridge exited (code ${code})`));
            }
            this.disposed = true;
            this.readyReject?.(new Error(`bridge exited (code ${code}) before Ready`));
            this.readyReject = undefined;
            this.cleanup();
        });
        proc.onError((err) => {
            getLogSink().error(getMsg(`bridge error: ${err.message}`));
        });

        getLogSink().info(getMsg(`started, agent=${this.sshAuthSock}`));
    }

    private onData(d: Buffer): void {
        this.inBuf = Buffer.concat([this.inBuf, d]);

        while (this.inBuf.length >= HEADER_SIZE) {
            const type = this.inBuf.readUInt16BE(TYPE_OFFSET) as FrameType;
            if (type >= FrameType.LAST) {
                getLogSink().warn(getMsg(`invalid frame type ${type}, dropping buffer`));
                this.inBuf = Buffer.alloc(0);
                break;
            }

            const chan = this.inBuf.readUInt32BE(CHANNEL_OFFSET);
            const len = this.inBuf.readUInt32BE(LENGTH_OFFSET);

            if (this.inBuf.length < HEADER_SIZE + len) { break; }

            const payload = len > 0
                ? Buffer.from(this.inBuf.subarray(HEADER_SIZE, HEADER_SIZE + len))
                : null;

            this.inBuf = this.inBuf.subarray(HEADER_SIZE + len);
            this.handleFrame(type, chan, payload);
        }
    }

    private handleFrame(type: FrameType, chan: number, payload: Buffer | null): void {
        if (type === FrameType.Ready) {
            getLogSink().info(getMsg("bridge ready"));
            this.readyResolve?.();
            this.readyResolve = undefined;
            this.readyReject = undefined;
            return;
        }
        if (type === FrameType.Open) {
            getLogSink().debug(getMsg(`ch${chan} Open -> connecting to agent`));
            this.openAgentConn(chan);
        }
        else if (type === FrameType.Data && payload) {
            getLogSink().debug(getMsg(`ch${chan} Data ${payload.length}B -> agent`));
            this.forwardToAgent(chan, payload);
        }
        else if (type === FrameType.Close) {
            getLogSink().debug(getMsg(`ch${chan} Close`));
            this.closeAgentConn(chan);
        }
    }

    private openAgentConn(chan: number): void {
        const conn = net.createConnection(this.sshAuthSock);
        this.agentConns.set(chan, conn);

        conn.on("connect", () => {
            getLogSink().debug(getMsg(`ch${chan} agent connected`));
        });
        conn.on("data", (d: Buffer) => {
            getLogSink().debug(getMsg(`ch${chan} agent->bridge ${d.length}B`));
            this.writeFrame(FrameType.Data, chan, d);
        });
        conn.on("error", (err) => {
            getLogSink().warn(getMsg(`ch${chan} agent error: ${err.message}`));
            this.writeFrame(FrameType.Close, chan, null);
            this.agentConns.delete(chan);
        });
        conn.on("close", () => {
            getLogSink().debug(getMsg(`ch${chan} agent closed`));
            if (this.agentConns.delete(chan)) {
                this.writeFrame(FrameType.Close, chan, null);
            }
        });
    }

    private forwardToAgent(chan: number, data: Buffer): void {
        const conn = this.agentConns.get(chan);
        if (conn) { conn.write(data); }
    }

    private closeAgentConn(chan: number): void {
        const conn = this.agentConns.get(chan);
        if (conn) {
            conn.destroy();
            this.agentConns.delete(chan);
        }
    }

    private writeFrame(type: FrameType, chan: number, data: Buffer | null): void {
        if (this.disposed) { return; }

        const hdr = Buffer.alloc(HEADER_SIZE);
        hdr.writeUInt16BE(type, TYPE_OFFSET);
        hdr.writeUInt32BE(chan, CHANNEL_OFFSET);
        hdr.writeUInt32BE(data ? data.length : 0, LENGTH_OFFSET);
        this.proc.stdin.write(hdr);

        if (data && data.length > 0) { this.proc.stdin.write(data); }
    }

    private cleanup(): void {
        for (const [, conn] of this.agentConns) { conn.destroy(); }
        this.agentConns.clear();
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        getLogSink().info(getMsg(`disposing (${this.agentConns.size} active agent conns)`));
        this.proc.stdin.end();
        this.cleanup();
    }
}
