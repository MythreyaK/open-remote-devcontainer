import * as vscode from "vscode";

import { getContainerEngineVersion, openRemote } from "./extension/commands";
import { AUTHORITY_BASE, DevContainerResolver } from "./remote/resolver";
import { initLog, getLogSink } from "./extension/log";

export const EXTENSION_ID: string = "open-remote-devcontainer";
export const EXTENSION_PRETTY_NAME: string = "Remote - DevContainers";

function getCmd(suffix: string) {
    return `${EXTENSION_ID}.${suffix}`;
}

export function activate(context: vscode.ExtensionContext) {
    initLog(EXTENSION_PRETTY_NAME);

    const logger = getLogSink();
    logger.info(`Activating ${EXTENSION_PRETTY_NAME} (${EXTENSION_ID})`);

    const remoteResolver = new DevContainerResolver(context);

    // TODO: multiple workspaces
    const wsfs = vscode.workspace.workspaceFolders;
    if (!wsfs || wsfs.length === 0) {
        throw new Error("Open extension in a workspace");
    };

    const localWsf = wsfs[0].uri.fsPath;
    context.subscriptions.push(
        vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY_BASE, remoteResolver),
        remoteResolver,
        vscode.commands.registerCommand(getCmd("getVersion"), () => getContainerEngineVersion(localWsf)),
        vscode.commands.registerCommand(getCmd("openRemote"), () => openRemote(localWsf, context)),
        logger,
    );
}

export function deactivate() { }
