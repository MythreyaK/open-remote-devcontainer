import * as vscode from "vscode";
import { mkdirSync } from "node:fs";
import path from "node:path";

import * as cmds from "./extension/commands";
import { BuildOpts } from "./engine/lifecycle";
import { AUTHORITY_BASE, DevContainerResolver } from "./remote/resolver";
import { EXTENSION_ID, EXTENSION_PRETTY_NAME } from "./common/constants";
import { getLocalWorkspaceFolder, getWorkspaceId } from "./extension/workspace";
import { initLog, getLogSink, initLogfile, getLogfileInfo } from "./extension/log";

function getCmd(suffix: string) {
    return `${EXTENSION_ID}.${suffix}`;
}

function initLogs(ctx: vscode.ExtensionContext) {
    // mmmm spaghetti
    initLog(EXTENSION_PRETTY_NAME);
    const logSlug = getWorkspaceId(getLocalWorkspaceFolder());
    const [dir, name] = getLogfileInfo(ctx, logSlug);
    mkdirSync(dir, { recursive: true });
    const fullPath = path.join(dir, name);
    initLogfile(fullPath);
    return fullPath;
}

export function activate(ctx: vscode.ExtensionContext) {
    initLogs(ctx);

    const logger = getLogSink();
    logger.info(`Activating ${EXTENSION_PRETTY_NAME} (${EXTENSION_ID})`);

    const remoteResolver = new DevContainerResolver(ctx);

    ctx.subscriptions.push(
        vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY_BASE, remoteResolver),
        remoteResolver,
        vscode.commands.registerCommand(getCmd("getVersion"), async () => { await cmds.getContainerEngineVersion(); }),
        vscode.commands.registerCommand(getCmd("openRemote"), async () => { await cmds.openRemote(ctx); }),
        vscode.commands.registerCommand(getCmd("rebuildOpenRemote"), async () => { await cmds.openRemote(ctx, BuildOpts.Rebuild); }),
        vscode.commands.registerCommand(getCmd("rebuildNoCacheOpenRemote"), async () => { await cmds.openRemote(ctx, BuildOpts.RebuildNoCache); }),
        vscode.commands.registerCommand(getCmd("showDevcontainerFile"), () => { cmds.showDevcontainerFile(); }),
        vscode.commands.registerCommand(getCmd("openLocal"), async () => { await cmds.openLocal(); }),
        vscode.commands.registerCommand(getCmd("showLog"), () => { cmds.showLogFile(); }),
        logger,
    );
}

export function deactivate() { }
