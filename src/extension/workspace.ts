import * as vscode from "vscode";
import path from "node:path";
import { existsSync } from "node:fs";
import * as crypto from "node:crypto";

import { InternalError } from "./error";

export function getActiveWorkspace(): string {
    const workspaces = vscode.workspace.workspaceFolders;

    // TODO: handle multi-workspace folders
    if (!workspaces || workspaces.length === 0) {
        throw new InternalError("This extension must be opened in a workspace");
    }

    return workspaces[0].uri.fsPath;
}

export function getWorkspaceId(): string {
    return crypto
        .createHash("sha256")
        .update(getActiveWorkspace())
        .digest("hex")
        .slice(0, 8);
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
