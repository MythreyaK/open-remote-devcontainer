import * as vscode from "vscode";

export function getActiveWorkspace(): string {
    const workspaces = vscode.workspace.workspaceFolders;

    // TODO: handle multi-workspace folders
    if (!workspaces || workspaces.length === 0) {
        throw new Error("This extension must be opened in a workspace");
    }

    return workspaces[0].uri.fsPath;
}
