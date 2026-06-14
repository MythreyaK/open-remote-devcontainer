import * as vscode from 'vscode';
import { InternalError } from './error';
import * as crypto from 'node:crypto';

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
        .createHash('sha256')
        .update(getActiveWorkspace())
        .digest('hex')
        .slice(16);
}
