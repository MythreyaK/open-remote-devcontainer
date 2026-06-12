import * as vscode from 'vscode';
import { InternalError } from './error';

export function getActiveWorkspace(): string {
    const workspaces = vscode.workspace.workspaceFolders;

    // TODO: handle multi-workspace folders
    if (!workspaces || workspaces.length == 0) {
        throw new InternalError("This extension must be opened in a workspace");
    }

    return workspaces[0].uri.fsPath;
}
