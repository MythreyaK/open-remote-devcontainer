import * as vscode from "vscode";

import * as cmds from "./extension/commands";
import { BuildOpts } from "./engine/lifecycle";
import { getLogSink, initLogs } from "./extension/log";
import { AUTHORITY_BASE, DevContainerResolver } from "./remote/resolver";
import { createDevcontainerConfigWatcher, isRemoteDevcontainerSession, onWorkspaceReady } from "./extension/workspace";
import { checkVersionAndNotify } from "./extension/releaseNotes";
import { checkLegacySettings } from "./extension/settings";

export function activate(ctx: vscode.ExtensionContext) {
    const logger = initLogs(ctx);

    const remoteResolver = new DevContainerResolver(ctx);

    ctx.subscriptions.push(
        vscode.workspace.registerRemoteAuthorityResolver(AUTHORITY_BASE, remoteResolver),
        remoteResolver,
        vscode.commands.registerCommand(cmds.getCmd("getVersion"), async () => { await cmds.getContainerEngineVersion(); }),
        vscode.commands.registerCommand(cmds.getCmd("openRemote"), async () => { await cmds.openRemote(ctx); }),
        vscode.commands.registerCommand(cmds.getCmd("rebuildOpenRemote"), async () => { await cmds.openRemote(ctx, BuildOpts.Rebuild); }),
        vscode.commands.registerCommand(cmds.getCmd("rebuildNoCacheOpenRemote"), async () => { await cmds.openRemote(ctx, BuildOpts.RebuildNoCache); }),
        vscode.commands.registerCommand(cmds.getCmd("showDevcontainerFile"), async () => { await cmds.showDevcontainerFile(); }),
        vscode.commands.registerCommand(cmds.getCmd("openLocal"), async () => { await cmds.openLocal(); }),
        vscode.commands.registerCommand(cmds.getCmd("showLog"), () => { cmds.showLogFile(); }),
        vscode.commands.registerCommand(cmds.getCmd("clearGlobalState"), () => { cmds.clearGlobalState(ctx); }),
        logger,
    );

    void createDevcontainerConfigWatcher(ctx).then((watcher) => {
        ctx.subscriptions.push(watcher);
    }).catch((e: unknown) => {
        getLogSink().error(`createDevcontainerConfigWatcher failed: ${JSON.stringify(e)}`);
    });

    if (isRemoteDevcontainerSession()) {
        onWorkspaceReady()?.then(async () => {
            getLogSink().info("onWorkspaceReady: workspace ready");
            try {
                await cmds.onRemoteReady(ctx);
                getLogSink().info("onRemoteReady: OK");
            }
            catch (e: unknown) {
                getLogSink().error(`onRemoteReady: Error ${JSON.stringify(e)}`);
            }
        });
    }

    checkVersionAndNotify(ctx);
    checkLegacySettings();
}

export function deactivate() { }
