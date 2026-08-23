import * as vscode from "vscode";

import { ExecCtx, ExecCtxKind, FsCtx } from "./execCtx";
import { HostUserInfo } from "../utils";
import { formatCmdErr } from "../spawn";
import { getLogSink } from "../../extension/log";
import { SpawnError } from "../../extension/error";
import { CmdResult, RunOpts } from "../opts";

let cmdCount: number = 0;

class RemoteFsCtx implements FsCtx {
    constructor(
        private readonly remoteFs: vscode.RemoteFileSystem,
    ) { }

    async stat(path: vscode.Uri): Promise<vscode.FileStat> {
        return this.remoteFs.stat(path.fsPath);
    }

    async read(path: vscode.Uri): Promise<string> {
        const stream = await this.remoteFs.read(path.fsPath);
        const chunks: Uint8Array[] = [];

        stream.onDidReceiveMessage((data) => {
            chunks.push(data);
        });

        await stream.onEnd;

        const decoder = new TextDecoder("utf-8");
        return decoder.decode(Buffer.concat(chunks));
    }

    async write(path: vscode.Uri, content: string): Promise<void> {
        const { stream, done } = await this.remoteFs.write(path.fsPath);
        stream.write(new TextEncoder().encode(content));
        stream.end();
        await done;
    }
}

export class RemoteExecCtx implements ExecCtx {
    kind: ExecCtxKind;
    fs: RemoteFsCtx;

    constructor(
        private readonly execServer: vscode.ExecServer,
    ) {
        this.kind = ExecCtxKind.ExecServer;
        this.fs = new RemoteFsCtx(execServer.fs);
    }

    public async run(cmdArgs: string[], opts: RunOpts): Promise<CmdResult> {
        return spawnRemote(this.execServer, cmdArgs, opts);
    }

    public async getHostUserInfo(): Promise<HostUserInfo> {
        const uid = await this.run(["id", "-u"], {});
        const gid = await this.run(["id", "-g"], {});
        const username = await this.run(["id", "-un"], {});

        if (uid.exit !== 0 || gid.exit !== 0) {
            throw new SpawnError(`RemoteExecCtx.getHostUserInfo: Could not query remote host user info: uid: ${formatCmdErr(uid)} gid: ${formatCmdErr(gid)}`);
        }

        if (username.exit !== 0) {
            getLogSink().warn(`RemoteExecCtx.getHostUserInfo: Could not query remote host user info: ${formatCmdErr(username)}`);
        }

        return {
            uid: parseInt(uid.stdout.trim(), 10),
            gid: parseInt(gid.stdout.trim(), 10),
            name: username.stdout.trim(),
        };
    }

    async env() {
        return this.execServer.env();
    }
}

export async function spawnRemote(execServer: vscode.ExecServer, cmdArgs: string[], opts: RunOpts) {
    cmdCount += 1;
    const cmdId = cmdCount;

    const [cmd, ...args] = cmdArgs;
    const log = getLogSink();

    const cmdStr = () => `CMD${String(cmdId).padStart(4, "0")}`;
    log.info(`RemoteExecCtx.spawn[${cmdStr()}]: [${cmdArgs.join(", ")}]`);

    const env: Record<string, string> = opts.env
        ? Object.fromEntries(
            Object.entries(opts.env)
                .filter((e): e is [string, string] => e[1] !== undefined),
        )
        : {};

    const spawned = await execServer.spawn(cmd, args, {
        cwd: opts.cwd,
        env: env,
    });

    if (opts.stdin !== undefined) {
        spawned.stdin.write(new TextEncoder().encode(opts.stdin));
        spawned.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    const decoder = new TextDecoder("utf-8");

    spawned.stdout.onDidReceiveMessage((data: Uint8Array) => {
        const chunk = decoder.decode(data, { stream: true });
        stdout += chunk;
        log.debug(`RemoteExecCtx.stdout.onDidReceiveMessage[${cmdStr()}]: len ${chunk.length}, chunk: '${chunk.trim()}'`);
    });

    spawned.stderr.onDidReceiveMessage((data: Uint8Array) => {
        const chunk = decoder.decode(data, { stream: true });
        stderr += chunk;
        log.debug(`RemoteExecCtx.stderr.onDidReceiveMessage[${cmdStr()}]: len ${chunk.length}, chunk: '${chunk.trim()}'`);
    });

    const exit = await spawned.onExit;
    const info: CmdResult = {
        exit: exit.status,
        stdout: stdout,
        stderr: stderr,
    };

    if (exit.status === 0) {
        log.info(`RemoteExecCtx[${cmdStr()}]: stdout: ${info.stdout.trim()}`);
    }
    else {
        log.error(`RemoteExecCtx[${cmdStr()}]: ${formatCmdErr(info)}`);
    }

    return { exit: exit.status, stdout, stderr };
}
