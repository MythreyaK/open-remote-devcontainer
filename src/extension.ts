import * as vscode from "vscode";

import * as cmds from "./extension/commands";
import { BuildOpts } from "./engine/lifecycle";
import { getLogSink, initLogs } from "./extension/log";
import { AUTHORITY_BASE, DevContainerResolver } from "./remote/resolver";
import { isRemoteDevcontainerSession, onWorkspaceReady } from "./extension/workspace";
import { checkVersionAndNotify } from "./extension/releaseNotes";
import { checkLegacySettings } from "./extension/settings";
import { setExecCtx } from "./common/ctx/ctx";
import { LocalExecCtx } from "./common/ctx/localCtx";
import { fmtErr } from "./common/utils";

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

    if (isRemoteDevcontainerSession()) {
        onWorkspaceReady()?.then(async () => {
            getLogSink().info("onWorkspaceReady: workspace ready");
            ctx.subscriptions.push(await cmds.setupConfigWatcher(ctx));
            try {
                await cmds.onRemoteReady(ctx);
                getLogSink().info("onRemoteReady: OK");
            }
            catch (e: unknown) {
                getLogSink().error(`onRemoteReady: Error ${fmtErr(e)}`);
            }
        });
    }
    else {
        void cmds.setupConfigWatcher(ctx).then((watcher) => {
            ctx.subscriptions.push(watcher);
        });

        // by "local", we mean "workspace-local". So on a remote machine (say ssh), local
        // means workspace-local. So spawn has to use the underlying resolver's exec server
        // plead it for one
        if (vscode.env.remoteAuthority /* && !isRemoteDevcontainerSession() */) {
            vscode.workspace.getRemoteExecServer(vscode.env.remoteAuthority).then(
                (server: vscode.ExecServer | undefined) => {
                    if (server) { setExecCtx(new LocalExecCtx(server)); }
                },
                (err: unknown) => {
                    getLogSink().error(`Could not getRemoteExecServer on '${vscode.env.remoteAuthority}'. Error: ${fmtErr(err)}`);
                },
            );
        }
    }

    checkVersionAndNotify(ctx);
    checkLegacySettings();
}

export function deactivate() { }
