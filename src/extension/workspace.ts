import * as vscode from "vscode";
import path from "node:path";
import * as crypto from "node:crypto";

import { getLogSink } from "./log";
import { ConfigError } from "./error";
import { AUTHORITY_BASE, decodeRemoteAuthority } from "../remote/resolver";
import * as cmds from "../extension/commands";
import { getExecCtx } from "../common/ctx/ctx";
import { fmtErr } from "../common/utils";
import { parseDevcontainer } from "../parser/parser";
import { ContainerConfig } from "../engine/container";

export enum NotificationLevel {
    Info,
    Warning,
    Error,
};

export const ConfigPaths = (dir: vscode.Uri) => [
    vscode.Uri.joinPath(dir, ".devcontainer.json"),
    vscode.Uri.joinPath(dir, ".devcontainer", "devcontainer.json"),
    // vscode.Uri.joinPath(dir, ".config", ".devcontainer", "devcontainer.json"),
];

/**
 *
 * @param localWsp : Full path to the local workspace folder, without resolving symlinks
 * @returns
 */
export function getWorkspaceId(localWsp: string): string {
    return crypto
        .createHash("sha256")
        .update(localWsp)
        .digest("hex")
        .slice(0, 16);
}

async function fileExists(filePath: vscode.Uri): Promise<boolean> {
    getLogSink().debug(`fileExists check: '${filePath.toString(true)}'`);
    try {
        await getExecCtx().fs.stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}

export async function findDevcontainerJson(dir: vscode.Uri): Promise<vscode.Uri> {
    getLogSink().debug(`Searching '${dir.toString(true)}' for config files ...`);
    const filePaths = ConfigPaths(dir);
    for (const f of filePaths) {
        if (await fileExists(f)) {
            getLogSink().info(`Using devcontainer.json at '${f.toString(true)}'`);
            return f;
        }
    }

    throw new ConfigError(`devcontainer.json not found. Searched: ${filePaths.map(u => u.toString(true)).join(", ")}`);
}

export function isRemoteDevcontainerSession(): boolean {
    return vscode.env.remoteAuthority?.startsWith(AUTHORITY_BASE) ?? false;
}

export function getLocalWorkspaceFolder(): vscode.Uri {
    getLogSink().info(`getLocalWorkspaceFolder: remote is ${vscode.env.remoteAuthority}`);
    if (isRemoteDevcontainerSession()) {
        const remote = vscode.env.remoteAuthority;
        return decodeRemoteAuthority(remote!); // eslint-disable-line @typescript-eslint/no-non-null-assertion
    }
    // for remotes that aren't devcontainer (say, ssh), the workspace
    // is "local" from extension's pov, so use "local" workspace
    else {
        const wsf = vscode.workspace.workspaceFolders;
        if (!wsf || wsf.length === 0) {
            throw new Error("Open a workspace");
        }
        return wsf[0].uri;
    }
}

export function showNotification(level: NotificationLevel, msg: string) {
    switch (level) {
        case NotificationLevel.Info: {
            vscode.window.showInformationMessage(msg);
            break;
        }
        case NotificationLevel.Warning: {
            vscode.window.showWarningMessage(msg);
            break;
        }
        case NotificationLevel.Error: {
            vscode.window.showErrorMessage(msg);
            break;
        }
    }
}

export function updateHasConfigContext(hasConfig: boolean) {
    vscode.commands.executeCommand("setContext", "open-remote-devcontainer.hasConfig", hasConfig);
}

export async function createDevcontainerConfigWatcher(ctx: vscode.ExtensionContext) {
    let configPath: vscode.Uri | undefined;

    try {
        const workspace = getLocalWorkspaceFolder();
        configPath = await findDevcontainerJson(workspace);
        updateHasConfigContext(true);

        if (!isRemoteDevcontainerSession()) {
            onOpenNotify(workspace.fsPath);
        }
    }
    catch (e) {
        updateHasConfigContext(false);
        if (e instanceof Error) {
            getLogSink().error(`Watcher: No workspace or config found: ${e.message}`);
        }
        else {
            getLogSink().error(`Unknown error: ${fmtErr(e)}`);
        }
        return new vscode.Disposable(() => { });
    }

    const localWsf = getLocalWorkspaceFolder();
    const parsedConfig = await parseDevcontainer(configPath);
    const cc = ContainerConfig.create(localWsf.fsPath, configPath.fsPath, parsedConfig);
    const watchPath = remapToCurrentAuthority(localWsf, configPath, cc.getRemoteMountDir());
    const configName = path.posix.basename(watchPath.path);
    const configDir = vscode.Uri.joinPath(watchPath, "..");
    const pattern = new vscode.RelativePattern(configDir, configName);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    watcher.onDidChange(() => {
        if (!isRemoteDevcontainerSession()) { return; }
        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(async () => {
            try {
                await cmds.remotePromptRebuildIfStale(ctx);
            }
            catch (e: unknown) {
                getLogSink().error(`remotePromptRebuildIfStale failed: ${fmtErr(e)}`);
            }
        }, 500);
    });
    watcher.onDidCreate(() => { updateHasConfigContext(true); });
    watcher.onDidDelete(() => { updateHasConfigContext(false); });

    return watcher;
}

export function remapToCurrentAuthority(localWsf: vscode.Uri, filePath: vscode.Uri, remoteMountDir: string): vscode.Uri {
    if (!isRemoteDevcontainerSession()) {
        return filePath;
    }
    const authority = vscode.env.remoteAuthority;
    if (!authority) { return filePath; }

    const relativePath = path.posix.relative(localWsf.path, filePath.path);
    return vscode.Uri.from({
        scheme: "vscode-remote",
        authority,
        path: path.posix.join(remoteMountDir, relativePath),
    });
}

export function onWorkspaceReady() {
    // wait for remote workspace
    const wsf = vscode.workspace.workspaceFolders;
    if (wsf && wsf.length > 0) {
        return vscode.workspace.fs.stat(wsf[0].uri);
    }
    return undefined;
}

function onOpenNotify(_: string) {
    // TODO: Store preference per-workspace
    enum OpenOpts {
        Yes = "Yes",
        No = "No",
        // DontShow = "Don't show again"
    };

    vscode.window.showInformationMessage(
        "devcontainer configuration detected. Open in devcontainer?",
        ...Object.values(OpenOpts)).then((opt) => {
        if (opt === OpenOpts.Yes) {
            vscode.commands.executeCommand(cmds.getCmd("openRemote"));
        }
    });
}
