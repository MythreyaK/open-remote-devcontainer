import * as vscode from "vscode";

import * as cmds from "./extension/commands";
import { BuildOpts } from "./engine/lifecycle";
import { initLogs } from "./extension/log";
import { AUTHORITY_BASE, DevContainerResolver } from "./remote/resolver";
import { createDevcontainerConfigWatcher, isRemoteSession } from "./extension/workspace";

export function activate(ctx: vscode.ExtensionContext) {
    const logger = initLogs(ctx);

    const remoteResolver = new DevContainerResolver(ctx);

    const configWatcher = createDevcontainerConfigWatcher();

    ctx.subscriptions.push(
        vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY_BASE, remoteResolver),
        remoteResolver,
        vscode.commands.registerCommand(cmds.getCmd("getVersion"), async () => { await cmds.getContainerEngineVersion(); }),
        vscode.commands.registerCommand(cmds.getCmd("openRemote"), async () => { await cmds.openRemote(ctx); }),
        vscode.commands.registerCommand(cmds.getCmd("rebuildOpenRemote"), async () => { await cmds.openRemote(ctx, BuildOpts.Rebuild); }),
        vscode.commands.registerCommand(cmds.getCmd("rebuildNoCacheOpenRemote"), async () => { await cmds.openRemote(ctx, BuildOpts.RebuildNoCache); }),
        vscode.commands.registerCommand(cmds.getCmd("showDevcontainerFile"), () => { cmds.showDevcontainerFile(); }),
        vscode.commands.registerCommand(cmds.getCmd("openLocal"), async () => { await cmds.openLocal(); }),
        vscode.commands.registerCommand(cmds.getCmd("showLog"), () => { cmds.showLogFile(); }),
        configWatcher,
        logger,
    );

    if (isRemoteSession()) {
        cmds.runPostAttachCommand();
    }
}

export function deactivate() { }
