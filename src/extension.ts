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

    context.subscriptions.push(
        vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY_BASE, remoteResolver),
        remoteResolver,
        vscode.commands.registerCommand(getCmd("getVersion"), () => getContainerEngineVersion()),
        vscode.commands.registerCommand(getCmd("openRemote"), () => openRemote(context)),
        vscode.commands.registerCommand(getCmd("showDevcontainerFile"), () => { showDevcontainerFile(); }),
        vscode.commands.registerCommand(getCmd("openLocal"), () => { openLocal(); }),
        logger,
    );
}

export function deactivate() { }
