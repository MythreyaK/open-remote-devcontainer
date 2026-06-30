import * as vscode from "vscode";

import * as cmd from "../common/cmd";
import { getContainerEngine } from "./settings";
import { ContainerConfig } from "../engine/container";
import { parseDevcontainerFile } from "../parser/parser";
import { encodeRemoteAuthority } from "../remote/resolver";
import { findDevcontainerJson, getLocalWorkspaceFolder } from "./workspace";
import { BuildOpts } from "../engine/lifecycle";
import { BuildOptIntent } from "../common/globalState";
import { getLogfilePath } from "./log";

export async function getContainerEngineVersion() {
    const localWsf = getLocalWorkspaceFolder();
    const { stdout } = await cmd.runCmd(getContainerEngine(), ["--version"], localWsf, {});
    vscode.window.showInformationMessage(`${getContainerEngine()} version: ${stdout}`);
}

export async function openRemote(ctx: vscode.ExtensionContext, opts: BuildOpts = BuildOpts.Default) {
    const localWsf = getLocalWorkspaceFolder();
    const devcontainerJson = findDevcontainerJson(localWsf);
    const parsedConfig = parseDevcontainerFile(devcontainerJson);
    const cc = ContainerConfig.create(localWsf, parsedConfig);

    BuildOptIntent.set(ctx, opts);

    const remoteWsf = cc.getRemoteMountDir();
    await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.from({
            scheme: "vscode-remote",
            authority: encodeRemoteAuthority(localWsf),
            path: remoteWsf,
        }),
    );
}

export async function openLocal() {
    const localWsf = getLocalWorkspaceFolder();

    await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(localWsf),
    );
}

export function showDevcontainerFile() {
    const file = findDevcontainerJson(getLocalWorkspaceFolder());
    vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
}

export function showLogFile() {
    const path = getLogfilePath();
    vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path));
}
