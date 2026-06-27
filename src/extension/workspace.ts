import * as vscode from "vscode";
import path from "node:path";
import { existsSync } from "node:fs";
import * as crypto from "node:crypto";

import { AUTHORITY_BASE, decodeRemoteAuthority } from "../remote/resolver";

export enum NotificationLevel {
    Info,
    Warning,
    Error,
};

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
    const filePaths = [
        path.join(dir, ".devcontainer", "devcontainer.json"),
        path.join(dir, ".devcontainer.json"),
    ];

    for (const f of filePaths) {
        if (existsSync(f)) {
            return f;
        }
    }

    throw new Error(`devcontainer.json not found. Searched: ${filePaths.join(", ")}`);
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
        if (!wsf || wsf.length == 0) {
            throw new Error("Open a workspace");
        }
        return wsf[0].uri.fsPath;
    }
}

export function showNotification(level: NotificationLevel, msg: string) {
    switch(level) {
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
