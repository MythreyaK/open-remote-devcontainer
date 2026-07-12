import * as vscode from "vscode";

import * as cmd from "../common/cmd";
import { getContainerEngine } from "./settings";
import { ContainerConfig, LifecycleCmd } from "../engine/container";
import { parseDevcontainerFile } from "../parser/parser";
import { encodeRemoteAuthority } from "../remote/resolver";
import { findDevcontainerJson, getLocalWorkspaceFolder, isRemoteSession, NotificationLevel, showNotification } from "./workspace";
import { BuildOpts, queryContainerConfigId } from "../engine/lifecycle";
import { BuildOptIntent } from "../common/globalState";
import { getLogfilePath } from "./log";
import { EXTENSION_ID } from "../common/constants";
import { InternalError } from "./error";

enum RebuildPrompt {
    RebuildNoCache = "Yes (Rebuild without cache)",
    Rebuild = "Yes",
    No = "No (Reuse existing)",
}

export function getCmd(suffix: string) {
    return `${EXTENSION_ID}.${suffix}`;
}

export async function getContainerEngineVersion() {
    const localWsf = getLocalWorkspaceFolder();
    const { stdout } = await cmd.runCmd(getContainerEngine(), ["--version"], localWsf, {});
    vscode.window.showInformationMessage(`${getContainerEngine()} version: ${stdout}`);
}

export async function openRemote(ctx: vscode.ExtensionContext, opts: BuildOpts = BuildOpts.Default) {
    const localWsf = getLocalWorkspaceFolder();
    const devcontainerJson = findDevcontainerJson(localWsf);
    const parsedConfig = parseDevcontainerFile(devcontainerJson);
    const cc = ContainerConfig.create(localWsf, devcontainerJson, parsedConfig);

    if (opts === BuildOpts.Default && await isConfigStale(localWsf, cc)) {
        const userOpt = await promptBuildOpt();
        if (userOpt === undefined) {
            vscode.window.showInformationMessage("Cancelled (no option selected).");
            return;
        }
        else {
            await _openRemote(ctx, localWsf, cc, toBuildOpts(userOpt)); // noreturn
            return;
        }
    }
    else {
        await _openRemote(ctx, localWsf, cc, opts); // noreturn
        return;
    }
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

async function _openRemote(ctx: vscode.ExtensionContext, localWsf: string, cc: ContainerConfig, opts: BuildOpts) {
    BuildOptIntent.set(ctx, opts);

    if (isRemoteSession() && opts === BuildOpts.Default) {
        // nothing to do, already on remote
        return;
    }
    if (isRemoteSession() && opts !== BuildOpts.Default) {
        // this is when rebuild/nocache options are used from a remote session
        // force a window reload so that the intent is picked up on next load
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        // technically redundant, but perhaps makes it clear the above is "noreturn"
        return;
    }

    await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.from({
            scheme: "vscode-remote",
            authority: encodeRemoteAuthority(localWsf),
            path: cc.getRemoteMountDir(),
        }),
    );
}

// other utilities

function promptBuildOpt() {
    return vscode.window.showInformationMessage(
        "Devcontainer configuration has changed. Rebuild container?",
        // { modal: opts.blockingNotify },
        ...Object.values(RebuildPrompt),
    );
}

export async function isConfigStale(localWsf: string, cc: ContainerConfig): Promise<boolean | undefined> {
    const containerConfigId = await queryContainerConfigId(localWsf);

    if (!containerConfigId) {
        return undefined;
    }

    return containerConfigId !== cc.getConfigId();
}

export function remotePromptRebuildIfStale(ctx: vscode.ExtensionContext) {
    if (!isRemoteSession()) {
        throw new InternalError("checkRemoteIsStale: Expected remote session.");
    }

    const localWsf = getLocalWorkspaceFolder();
    const devcontainerJson = findDevcontainerJson(localWsf);
    const parsedConfig = parseDevcontainerFile(devcontainerJson);
    const cc = ContainerConfig.create(localWsf, devcontainerJson, parsedConfig);

    isConfigStale(localWsf, cc).then((isStale) => {
        if (isStale) {
            return promptBuildOpt().then(async (userOpt) => {
                if (userOpt === undefined) {
                    vscode.window.showInformationMessage("Cancelled (no option selected).");
                    return;
                }
                else if (userOpt !== RebuildPrompt.No) {
                    await _openRemote(ctx, localWsf, cc, toBuildOpts(userOpt)); // noreturn
                    return;
                }
                else {
                    // if user says "no", then don't do anything
                    return;
                }
            });
        }
        return;
    }).catch((e: unknown) => {
        showNotification(NotificationLevel.Error, `Could not reopen: ${JSON.stringify(e)}`);
    });
}

function toBuildOpts(userOpt: undefined): undefined;
function toBuildOpts(userOpt: RebuildPrompt): BuildOpts;
function toBuildOpts(userOpt: RebuildPrompt | undefined) {
    switch (userOpt) {
        case RebuildPrompt.No: return BuildOpts.Default;
        case RebuildPrompt.Rebuild: return BuildOpts.Rebuild;
        case RebuildPrompt.RebuildNoCache: return BuildOpts.RebuildNoCache;
        default: return undefined;
    };
}
