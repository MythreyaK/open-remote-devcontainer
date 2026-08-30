import * as vscode from "vscode";

import * as cmd from "../common/cmd";
import { getSettings } from "./settings";
import { ContainerConfig, LifecycleCmd } from "../engine/container";
import { parseDevcontainer } from "../parser/parser";
import { encodeRemoteAuthority } from "../remote/resolver";
import { findDevcontainerJson, getLocalWorkspaceFolder, isRemoteDevcontainerSession, NotificationLevel, showNotification } from "./workspace";
import { BuildOpts, queryContainerConfigId } from "../engine/lifecycle";
import { BuildOptIntent } from "../common/globalState";
import { getLogfilePath, getLogSink } from "./log";
import { EXTENSION_ID } from "../common/constants";
import { InternalError } from "./error";
import { getEngineCmd } from "../common/utils";

enum RebuildPrompt {
    RebuildNoCache = "Yes (Rebuild without cache)",
    Rebuild = "Yes",
    No = "No (Reuse existing)",
}

export function getCmd(suffix: string) {
    return `${EXTENSION_ID}.${suffix}`;
}

export async function getContainerEngineVersion() {
    const engine = getSettings().dockerPath;
    const { stdout } = await cmd.run([engine, "--version"], {});
    vscode.window.showInformationMessage(`${engine} version: ${stdout}`);
}

export async function openRemote(ctx: vscode.ExtensionContext, opts: BuildOpts = BuildOpts.Default) {
    const localWsf = getLocalWorkspaceFolder();
    const devcontainerJson = await findDevcontainerJson(localWsf);
    const parsedConfig = await parseDevcontainer(devcontainerJson);
    const cc = ContainerConfig.create(localWsf.fsPath, devcontainerJson.fsPath, parsedConfig);

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
    await vscode.commands.executeCommand(
        "vscode.openFolder",
        getLocalWorkspaceFolder(),
    );
}

export async function showDevcontainerFile() {
    const file = await findDevcontainerJson(getLocalWorkspaceFolder());
    vscode.commands.executeCommand("vscode.open", file);
}

export function showLogFile() {
    const path = getLogfilePath();
    vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path));
}

export async function runPostAttachCommand() {
    const localWsf = getLocalWorkspaceFolder();
    const devcontainerJson = await findDevcontainerJson(localWsf);
    const parsedConfig = await parseDevcontainer(devcontainerJson);
    const cc = ContainerConfig.create(localWsf.fsPath, devcontainerJson.fsPath, parsedConfig);

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

async function _openRemote(ctx: vscode.ExtensionContext, localWsf: vscode.Uri, cc: ContainerConfig, opts: BuildOpts) {
    getLogSink().info(`_openRemote: localWsf: ${localWsf.toString(true)} cc.Id: ${cc.getConfigId()} opts: ${opts}`);
    BuildOptIntent.set(ctx, opts);

    if (isRemoteDevcontainerSession() && opts === BuildOpts.Default) {
        // nothing to do, already on remote
        return;
    }
    if (isRemoteDevcontainerSession() && opts !== BuildOpts.Default) {
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
            authority: encodeRemoteAuthority(localWsf.fsPath),
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

export async function isConfigStale(localWsf: vscode.Uri, cc: ContainerConfig): Promise<boolean | undefined> {
    const cmd = getEngineCmd(getSettings());
    const containerConfigId = await queryContainerConfigId(cmd, localWsf.fsPath);

    if (!containerConfigId) {
        return undefined;
    }

    return containerConfigId !== cc.getConfigId();
}

export async function remotePromptRebuildIfStale(ctx: vscode.ExtensionContext) {
    if (!isRemoteDevcontainerSession()) {
        throw new InternalError("checkRemoteIsStale: Expected remote session.");
    }

    const localWsf = getLocalWorkspaceFolder();
    const devcontainerJson = await findDevcontainerJson(localWsf);
    const parsedConfig = await parseDevcontainer(devcontainerJson);
    const cc = ContainerConfig.create(localWsf.fsPath, devcontainerJson.fsPath, parsedConfig);

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

export function clearGlobalState(ctx: vscode.ExtensionContext) {
    ctx.globalState.keys().forEach((k) => {
        getLogSink().info(`Clearing globalState '${k}'`);
        void ctx.globalState.update(k, undefined);
    });
}
