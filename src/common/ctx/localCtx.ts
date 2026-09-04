import * as vscode from "vscode";

import { ExecCtx, ExecCtxKind, FsCtx } from "./execCtx";
import { HostUserInfo } from "../utils";
import { formatCmdErr, spawn } from "../spawn";
import { getLogSink } from "../../extension/log";
import { SpawnError } from "../../extension/error";
import { CmdResult, RunOpts } from "../opts";
import { spawnRemote } from "./remoteCtx";

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
        this.kind = (execServer === undefined) ? ExecCtxKind.LocalSSH : ExecCtxKind.Local;
        this.execServer = execServer;
        this.fs = new LocalFsCtx();
    }

    async run(cmdArgs: string[], opts: RunOpts): Promise<CmdResult> {
        if (this.execServer) {
            return await spawnRemote(this.execServer, cmdArgs, opts);
        }
        return await spawn(cmdArgs[0], cmdArgs.slice(1), { ...opts, log: getLogSink() });
    }

    async getHostUserInfo(): Promise<HostUserInfo> {
        const userName = await spawn("id", ["-nu"], { log: getLogSink() });
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
}
