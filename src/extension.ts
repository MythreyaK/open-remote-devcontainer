import * as vscode from "vscode";

import { getContainerEngineVersion, openLocal, openRemote, showDevcontainerFile } from "./extension/commands";
import { AUTHORITY_BASE, DevContainerResolver } from "./remote/resolver";
import { EXTENSION_ID, EXTENSION_PRETTY_NAME } from "./common/constants";
import { initLog, getLogSink } from "./extension/log";
import { BuildOpts } from "./engine/lifecycle";

function getCmd(suffix: string) {
    return `${EXTENSION_ID}.${suffix}`;
}

export function activate(ctx: vscode.ExtensionContext) {
    initLog(EXTENSION_PRETTY_NAME);

    const logger = getLogSink();
    logger.info(`Activating ${EXTENSION_PRETTY_NAME} (${EXTENSION_ID})`);

    const remoteResolver = new DevContainerResolver(ctx);

    ctx.subscriptions.push(
        vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY_BASE, remoteResolver),
        remoteResolver,
        vscode.commands.registerCommand(getCmd("getVersion"), async () => { await getContainerEngineVersion(); }),
        vscode.commands.registerCommand(getCmd("openRemote"), async () => { await openRemote(ctx); }),
        vscode.commands.registerCommand(getCmd("rebuildOpenRemote"), async () => { await openRemote(ctx, BuildOpts.Rebuild); }),
        vscode.commands.registerCommand(getCmd("rebuildNoCacheOpenRemote"), async () => { await openRemote(ctx, BuildOpts.RebuildNoCache); }),
        vscode.commands.registerCommand(getCmd("showDevcontainerFile"), () => { showDevcontainerFile(); }),
        vscode.commands.registerCommand(getCmd("openLocal"), async () => { await openLocal(); }),
        logger,
    );
}

export function deactivate() { }
