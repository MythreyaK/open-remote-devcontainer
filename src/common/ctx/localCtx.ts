import * as vscode from "vscode";
import * as chproc from "node:child_process";

import { ExecCtx, ExecCtxKind, FsCtx, SpawnedProcess } from "./execCtx";
import { HostUserInfo } from "../utils";
import { collectOutput, formatCmdErr } from "../spawn";
import { getLogSink } from "../../extension/log";
import { SpawnError } from "../../extension/error";
import { CmdResult, RunOpts } from "../opts";
import { spawnRemote } from "./remoteCtx";
import * as settings from "../settings";

class LocalFsCtx implements FsCtx {
    async stat(path: vscode.Uri): Promise<vscode.FileStat> {
        return vscode.workspace.fs.stat(path);
    }

    async read(path: vscode.Uri): Promise<string> {
        const bytes = await vscode.workspace.fs.readFile(path);
        return new TextDecoder("utf-8").decode(bytes);
    }

    async write(path: vscode.Uri, content: string): Promise<void> {
        await vscode.workspace.fs.writeFile(
            path, Buffer.from(content));
    }
}

export class LocalExecCtx implements ExecCtx {
    kind: ExecCtxKind;
    execServer: vscode.ExecServer | undefined;
    fs: FsCtx;

    constructor(execServer?: vscode.ExecServer) {
        // By ensuring file paths are vscode.Uri, remote-local files are resolved automatically by vscode
        // nothing special to do here
        this.kind = (execServer === undefined) ? ExecCtxKind.Local : ExecCtxKind.LocalSSH;
        this.execServer = execServer;
        this.fs = new LocalFsCtx();
    }

    async run(cmdArgs: string[], opts: RunOpts): Promise<CmdResult> {
        const proc = await this.spawn(cmdArgs, opts);
        return collectOutput(proc, opts);
    }

    async spawn(cmdArgs: string[], opts: RunOpts): Promise<SpawnedProcess> {
        if (this.execServer) {
            return spawnRemote(this.execServer, cmdArgs, opts);
        }

        const [cmd, ...args] = cmdArgs;
        const proc = chproc.spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, BUILDKIT_PROGRESS: "plain", ...opts.env },
            stdio: ["pipe", "pipe", "pipe"],
        });

        return {
            stdin: {
                write(data: Buffer | Uint8Array) { proc.stdin.write(data); },
                end() { proc.stdin.end(); },
            },
            onStdout(cb) { proc.stdout.on("data", cb); },
            onStderr(cb) { proc.stderr.on("data", cb); },
            onError(cb) { proc.on("error", cb); },
            onExit(cb) { proc.on("exit", cb); },
            onClose(cb) { proc.on("close", cb); },
        };
    }

    async getHostUserInfo(): Promise<HostUserInfo> {
        const userName = await this.run(["id", "-nu"], {});
        /* eslint-disable @typescript-eslint/no-non-null-assertion */
        if (userName.exit === 0) {
            return {
                uid: process.getuid!(),
                gid: process.getgid!(),
                name: userName.stdout.trim(),
            };
        }
        else {
            throw new SpawnError(`Could not query host user info (uid, gid, name): ${formatCmdErr(userName)}`);
        }
        /* eslint-enable @typescript-eslint/no-non-null-assertion */
    }

    // eslint-disable-next-line  @typescript-eslint/require-await
    async env(): Promise<vscode.ExecEnvironment> {
        return {
            env: process.env as vscode.ProcessEnv,
            osPlatform: process.platform,
        };
    }

    // eslint-disable-next-line  @typescript-eslint/require-await
    async getSettings(): Promise<settings.Settings> {
        // for user-local or remote-local workspace, settings is just
        // querying it via vscode's API it does the right thing even
        // if on a remote machine
        const ret = settings.withDefaults(settings.getLocalSettings());

        getLogSink().debug(`LocalExecCtx.getSettings(): ${JSON.stringify(ret)}`);
        return ret;
    }
}
