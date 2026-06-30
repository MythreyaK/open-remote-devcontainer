import * as vscode from "vscode";

import * as cmd from "../common/cmd";
import { getContainerEngine } from "./settings";
import { ContainerConfig } from "../engine/container";
import { parseDevcontainerFile } from "../parser/parser";
import { encodeRemoteAuthority } from "../remote/resolver";
import { findDevcontainerJson, getLocalWorkspaceFolder, isRemoteSession } from "./workspace";
import { BuildOpts } from "../engine/lifecycle";
import { BuildOptIntent } from "../common/globalState";
import { getLogfilePath } from "./log";

export async function getContainerEngineVersion() {
    const localWsf = getLocalWorkspaceFolder();
    const { stdout } = await cmd.runCmd(getContainerEngine(), ["--version"], localWsf, {});
    vscode.window.showInformationMessage(`${getContainerEngine()} version: ${stdout}`);
}

export async function openRemote(ctx: vscode.ExtensionContext, opts: BuildOpts = BuildOpts.Default) {
    BuildOptIntent.set(ctx, opts);

    if (isRemoteSession() && opts !== BuildOpts.Default) {
        // this is when rebuild/nocache options are used from a remote session
        // force a window reload so that the intent is picked up on next load
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        // technically redundant, but perhaps makes it clear the above is "noreturn"
        return;
    }

    const localWsf = getLocalWorkspaceFolder();
    const devcontainerJson = findDevcontainerJson(localWsf);
    const parsedConfig = parseDevcontainerFile(devcontainerJson);
    const cc = ContainerConfig.create(localWsf, parsedConfig);

    await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.from({
            scheme: "vscode-remote",
            authority: encodeRemoteAuthority(localWsf),
            path: cc.getRemoteMountDir(),
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
