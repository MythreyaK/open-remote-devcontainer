import * as vscode from "vscode";

import { HostUserInfo } from "../utils";
import { CmdResult, RunOpts } from "../opts";

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

export interface ExecCtx {
    kind: ExecCtxKind,
    fs: FsCtx,
    run(cmdArgs: string[], opts: RunOpts): Promise<CmdResult>,
    getHostUserInfo(): Promise<HostUserInfo>,
    env(): Promise<vscode.ExecEnvironment>,
}
