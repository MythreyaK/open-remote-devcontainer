import * as vscode from "vscode";
import path from "node:path";
import { existsSync } from "node:fs";
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

export function findDevcontainerJson(dir: string): string {
    const filePaths = ConfigPaths(dir);
    for (const f of filePaths) {
        if (existsSync(f)) {
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

export function createDevcontainerConfigWatcher() {
    const emptyDisposable = new vscode.Disposable(() => { });
    let workspace: string | undefined;

    try {
        workspace = getLocalWorkspaceFolder();
        findDevcontainerJson(workspace);

        // if config failed, we throw, so safe to notify here
        if (!isRemoteSession()) {
            onOpenNotify(workspace);
        }
    }
    catch (e) {
        if (e instanceof Error) {
            getLogSink().error(`Watcher: No workspace or config found: ${e.message}`);
        }
        else {
            getLogSink().error(`Unknown error: ${JSON.stringify(e)}`);
        }
    }

    return emptyDisposable;
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
