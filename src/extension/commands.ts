import * as vscode from "vscode";

import * as cmd from "../common/cmd";
import { getContainerEngine } from "./settings";
import { ContainerConfig, LifecycleCmd } from "../engine/container";
import { parseDevcontainerFile } from "../parser/parser";
import { encodeRemoteAuthority } from "../remote/resolver";
import { findDevcontainerJson, getLocalWorkspaceFolder, isRemoteSession } from "./workspace";
import { BuildOpts } from "../engine/lifecycle";
import { BuildOptIntent } from "../common/globalState";
import { getLogfilePath } from "./log";
import { EXTENSION_ID } from "../common/constants";

export function getCmd(suffix: string) {
    return `${EXTENSION_ID}.${suffix}`;
}

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
    const cc = ContainerConfig.create(localWsf, devcontainerJson, parsedConfig);

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

export function runPostAttachCommand() {
    const localWsf = getLocalWorkspaceFolder();
    const devcontainerJson = findDevcontainerJson(localWsf);
    const parsedConfig = parseDevcontainerFile(devcontainerJson);
    const cc = ContainerConfig.create(localWsf, devcontainerJson, parsedConfig);

    const cmds = cc.getLifecycleCmd(LifecycleCmd.postAttach);

    for (const [name, cmdArgs] of Object.entries(cmds)) {
        const task = new vscode.Task(
            { type: "shell" },
            vscode.TaskScope.Workspace,
            `Post Attach: ${name}`,
            "devcontainer",
            new vscode.ProcessExecution(cmdArgs[0], cmdArgs.slice(1), {
                cwd: cc.getRemoteMountDir(),
            }),
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            close: false,
            group: "devcontainer-postAttach",
        };
        vscode.tasks.executeTask(task);
    }
}
