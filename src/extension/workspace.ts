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

export const ConfigPaths = (dir: vscode.Uri) => [
    vscode.Uri.joinPath(dir, ".devcontainer.json"),
    vscode.Uri.joinPath(dir, ".devcontainer", "devcontainer.json"),
    // vscode.Uri.joinPath(dir, ".config", ".devcontainer", "devcontainer.json"),
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

async function fileExists(filePath: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}

export async function findDevcontainerJson(dir: vscode.Uri): Promise<vscode.Uri> {
    const filePaths = ConfigPaths(dir);
    for (const f of filePaths) {
        if (await fileExists(f)) {
            getLogSink().info(`Using devcontainer.json at ${f.toString(true)}`);
            return f;
        }
    }

    throw new ConfigError(`devcontainer.json not found. Searched: ${filePaths.map(u => u.toString(true)).join(", ")}`);
}

export function isRemoteDevcontainerSession(): boolean {
    return vscode.env.remoteAuthority?.startsWith(AUTHORITY_BASE) ?? false;
}

export function getLocalWorkspaceFolder(): vscode.Uri {
    const remote = vscode.env.remoteAuthority;
    if (remote?.startsWith(AUTHORITY_BASE)) {
        return decodeRemoteAuthority(remote);
    }
    // for remotes that aren't devcontainer (say, ssh), the workspace
    // is "local" from extension's pov, so use "local" workspace
    else {
        const wsf = vscode.workspace.workspaceFolders;
        if (!wsf || wsf.length === 0) {
            throw new Error("Open a workspace");
        }
        return wsf[0].uri;
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
    let configPath: vscode.Uri | undefined;

    try {
        const workspace = getLocalWorkspaceFolder();
        configPath = await findDevcontainerJson(workspace);
        updateHasConfigContext(true);

        if (!isRemoteDevcontainerSession()) {
            onOpenNotify(workspace.fsPath);
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

    const configName = path.posix.basename(configPath.path);
    const configDir = vscode.Uri.joinPath(configPath, "..");
    const pattern = new vscode.RelativePattern(configDir, configName);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(async () => {
        if (isRemoteDevcontainerSession()) {
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

export function onWorkspaceReady() {
    // wait for remote workspace
    const wsf = vscode.workspace.workspaceFolders;
    if (wsf && wsf.length > 0) {
        return vscode.workspace.fs.stat(wsf[0].uri);
    }
    return undefined;
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
