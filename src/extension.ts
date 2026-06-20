import * as vscode from "vscode";

import { getContainerEngineVersion, openRemote } from "./extension/commands";
import { AUTHORITY_BASE, DevContainerResolver } from "./remote/resolver";
import { initLog, getLogSink } from "./extension/log";

export function activate(context: vscode.ExtensionContext) {
    initLog("Remote - Devcontainers");

    const logger = getLogSink();
    logger.info("Activating open-remote-devcontainer");

    const remoteResolver = new DevContainerResolver(context);

    context.subscriptions.push(
        vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY_BASE, remoteResolver),
        remoteResolver,
        vscode.commands.registerCommand("open-remote-devcontainer.getVersion", getContainerEngineVersion),
        vscode.commands.registerCommand("open-remote-devcontainer.openRemote", openRemote),
        logger,
    );
}

export function deactivate() { }
