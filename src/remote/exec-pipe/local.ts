import * as net from "net";
import path from "node:path";

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getLogSink } from "../../extension/log";
import { EXTENSION_ID } from "../../common/constants";

import {
    FrameType,
    HEADER_SIZE,
    TYPE_OFFSET,
    CHANNEL_OFFSET,
    LENGTH_OFFSET,
} from "./remote";

export const SSH_AGENT_SOCK_DIR = `/tmp/codium-${EXTENSION_ID}-ipc`;

export function sshAgentSockPath(): string {
    return path.posix.join(SSH_AGENT_SOCK_DIR, `ssh-agent-fwd-${randomUUID()}.sock`);
}

export class SshAgentRelay {
    private static readonly TAG = "ssh-agent-relay";
    private readonly agentConns = new Map<number, net.Socket>();
    private inBuf = Buffer.alloc(0);
    private disposed = false;
    private readyResolve: (() => void) | undefined;
    readonly ready: Promise<void>;

    constructor(
        private readonly proc: ChildProcess,
        private readonly sshAuthSock: string,
        readonly containerSockPath: string,
    ) {
        this.ready = new Promise((resolve) => { this.readyResolve = resolve; });

        proc.stdout?.on("data", (d: Buffer) => { this.onData(d); });
        proc.stderr?.on("data", (d: Buffer) => {
            getLogSink().info(`${SshAgentRelay.TAG}: ${d.toString().trim()}`);
        });
        proc.on("exit", (code) => {
            if (!this.disposed) {
                getLogSink().warn(`${SshAgentRelay.TAG}: bridge exited (code ${code})`);
            }
            this.cleanup();
        });
        proc.on("error", (err) => {
            getLogSink().error(`${SshAgentRelay.TAG}: bridge error: ${err.message}`);
        });
        getLogSink().info(`${SshAgentRelay.TAG}: started, agent=${this.sshAuthSock}`);
    }

    private onData(d: Buffer): void {
        this.inBuf = Buffer.concat([this.inBuf, d]);
        while (this.inBuf.length >= HEADER_SIZE) {
            const type: FrameType = this.inBuf.readUInt16BE(TYPE_OFFSET) as FrameType;
            const chan = this.inBuf.readUInt32BE(CHANNEL_OFFSET);
            const len = this.inBuf.readUInt32BE(LENGTH_OFFSET);

            if (this.inBuf.length < HEADER_SIZE + len) { break; }
            const payload = len > 0 ? Buffer.from(this.inBuf.subarray(HEADER_SIZE, HEADER_SIZE + len)) : null;
            this.inBuf = this.inBuf.subarray(HEADER_SIZE + len);
            this.handleFrame(type, chan, payload);
        }
    }

    private handleFrame(type: FrameType, chan: number, payload: Buffer | null): void {
        if (type === FrameType.Ready) {
            getLogSink().info(`${SshAgentRelay.TAG}: bridge ready`);
            this.readyResolve?.();
            this.readyResolve = undefined;
            return;
        }
        if (type === FrameType.Open) {
            getLogSink().debug(`${SshAgentRelay.TAG}: ch${chan} Open → connecting to agent`);
            this.openAgentConn(chan);
        }
        else if (type === FrameType.Data && payload) {
            getLogSink().debug(`${SshAgentRelay.TAG}: ch${chan} Data ${payload.length}B → agent`);
            this.forwardToAgent(chan, payload);
        }
        else if (type === FrameType.Close) {
            getLogSink().debug(`${SshAgentRelay.TAG}: ch${chan} Close`);
            this.closeAgentConn(chan);
        }
    }

    private openAgentConn(chan: number): void {
        const conn = net.createConnection(this.sshAuthSock);
        this.agentConns.set(chan, conn);

        conn.on("connect", () => {
            getLogSink().debug(`${SshAgentRelay.TAG}: ch${chan} agent connected`);
        });
        conn.on("data", (d: Buffer) => {
            getLogSink().debug(`${SshAgentRelay.TAG}: ch${chan} agent→bridge ${d.length}B`);
            this.writeFrame(FrameType.Data, chan, d);
        });
        conn.on("error", (err) => {
            getLogSink().warn(`${SshAgentRelay.TAG}: ch${chan} agent error: ${err.message}`);
            this.writeFrame(FrameType.Close, chan, null);
            this.agentConns.delete(chan);
        });
        conn.on("close", () => {
            getLogSink().debug(`${SshAgentRelay.TAG}: ch${chan} agent closed`);
            this.agentConns.delete(chan);
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
        if (this.disposed || !this.proc.stdin?.writable) { return; }
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
        getLogSink().info(`${SshAgentRelay.TAG}: disposing (${this.agentConns.size} active agent conns)`);
        this.proc.stdin?.end();
        this.proc.kill();
        this.cleanup();
    }
}
