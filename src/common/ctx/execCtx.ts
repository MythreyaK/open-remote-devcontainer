import * as vscode from "vscode";

import { HostUserInfo } from "../utils";
import { CmdResult, RunOpts } from "../opts";
import { Settings } from "../settings";

export enum ExecCtxKind {
    Local = "Local",
    LocalSSH = "LocalSSH", // counterintuitive, but this means "local workspace" is on a remote machine
    ExecServer = "ExecServer", // devcontainer over chained resolver (devcontainer over ssh remote)
}

export interface FsCtx {
    stat(filePath: vscode.Uri): Promise<vscode.FileStat>,
    read(filePath: vscode.Uri): Promise<string>,
    write(filePath: vscode.Uri, content: string): Promise<void>,
};

export interface SpawnedProcess {
    readonly stdin: { write(data: Buffer | Uint8Array): void, end(): void },
    onStdout(cb: (data: Buffer) => void): void,
    onStderr(cb: (data: Buffer) => void): void,
    onError(cb: (err: Error) => void): void,
    onExit(cb: (code: number | null) => void): void,
    onClose(cb: () => void): void,
}

export interface ExecCtx {
    kind: ExecCtxKind,
    fs: FsCtx,
    run(cmdArgs: string[], opts: RunOpts): Promise<CmdResult>,
    spawn(cmdArgs: string[], opts: RunOpts): Promise<SpawnedProcess>,
    getHostUserInfo(): Promise<HostUserInfo>,
    env(): Promise<vscode.ExecEnvironment>,
    getSettings(): Promise<Settings>,
}
