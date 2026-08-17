import * as vscode from "vscode";
import path from "node:path";
import * as crypto from "node:crypto";

import { getLogSink } from "./log";
import { ConfigError } from "./error";
import { AUTHORITY_BASE, decodeRemoteAuthority } from "../remote/resolver";
import * as cmds from "../extension/commands";

export enum NotificationLevel {
    Info,
    Warning,
    Error,
};

export const ConfigPaths = (dir: string) => [
    path.join(dir, ".devcontainer.json"),
    path.join(dir, ".devcontainer", "devcontainer.json"),
    // path.join(dir, ".config", ".devcontainer", "devcontainer.json"),
];

/**
 *
 * @param localWsp : Full path to the local workspace folder, without resolving symlinks
 * @returns
 */
export function getWorkspaceId(localWsp: string): string {
    return crypto
        .createHash("sha256")
        .update(localWsp)
        .digest("hex")
        .slice(0, 16);
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        return true;
    }
    catch {
        return false;
    }
}

export async function findDevcontainerJson(dir: string): Promise<string> {
    const filePaths = ConfigPaths(dir);
    for (const f of filePaths) {
        if (await fileExists(f)) {
            getLogSink().info(`Using devcontainer.json at ${f}`);
            return f;
        }
    }

    throw new ConfigError(`devcontainer.json not found. Searched: ${filePaths.join(", ")}`);
}

export function isRemoteSession() {
    return vscode.env.remoteAuthority !== undefined;
}

export function getLocalWorkspaceFolder(): string {
    if (isRemoteSession()) {
        if (vscode.env.remoteAuthority?.startsWith(AUTHORITY_BASE)) {
            return decodeRemoteAuthority(vscode.env.remoteAuthority);
        }
        else {
            throw new Error("Could not determine remote authority for workspace detection");
        }
    }
    else {
        const wsf = vscode.workspace.workspaceFolders;
        if (!wsf || wsf.length === 0) {
            throw new Error("Open a workspace");
        }
        return wsf[0].uri.fsPath;
    }
}

export function showNotification(level: NotificationLevel, msg: string) {
    switch (level) {
        case NotificationLevel.Info: {
            vscode.window.showInformationMessage(msg);
            break;
        }
        case NotificationLevel.Warning: {
            vscode.window.showWarningMessage(msg);
            break;
        }
        case NotificationLevel.Error: {
            vscode.window.showErrorMessage(msg);
            break;
        }
    }
}

export function updateHasConfigContext(hasConfig: boolean) {
    vscode.commands.executeCommand("setContext", "open-remote-devcontainer.hasConfig", hasConfig);
}

export async function createDevcontainerConfigWatcher(ctx: vscode.ExtensionContext) {
    let configPath: string | undefined;

    try {
        const workspace = getLocalWorkspaceFolder();
        configPath = await findDevcontainerJson(workspace);
        updateHasConfigContext(true);

        if (!isRemoteSession()) {
            onOpenNotify(workspace);
        }
    }
    catch (e) {
        updateHasConfigContext(false);
        if (e instanceof Error) {
            getLogSink().error(`Watcher: No workspace or config found: ${e.message}`);
        }
        else {
            getLogSink().error(`Unknown error: ${JSON.stringify(e)}`);
        }
        return new vscode.Disposable(() => { });
    }

    const pattern = new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(configPath)),
        path.basename(configPath),
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(async () => {
        if (isRemoteSession()) {
            try {
                await cmds.remotePromptRebuildIfStale(ctx);
            }
            catch (e: unknown) {
                if (e instanceof Error) {
                    getLogSink().error(`remotePromptRebuildIfStale failed ${e.message}`);
                }
                else {
                    getLogSink().error(`remotePromptRebuildIfStale failed ${JSON.stringify(e)}`);
                }
            }
        }
    });
    watcher.onDidCreate(() => { updateHasConfigContext(true); });
    watcher.onDidDelete(() => { updateHasConfigContext(false); });

    return watcher;
}

function onOpenNotify(_: string) {
    // TODO: Store preference per-workspace
    enum OpenOpts {
        Yes = "Yes",
        No = "No",
        // DontShow = "Don't show again"
    };

    vscode.window.showInformationMessage(
        "devcontainer configuration detected. Open in devcontainer?",
        ...Object.values(OpenOpts)).then((opt) => {
        if (opt === OpenOpts.Yes) {
            vscode.commands.executeCommand(cmds.getCmd("openRemote"));
        }
    });
}
