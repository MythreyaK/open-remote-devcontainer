import * as vscode from "vscode";

import { getExecCtx } from "../common/ctx/ctx";
import { ExecCtxKind } from "../common/ctx/execCtx";
import { getRemoteserverConfiguration } from "./remoteSettings";
import { getLogSink } from "./log";

export interface Settings {
    dockerPath: string,
    extraArgs: string[],
    defaultExtensions: string[],
}

let _settings: Settings | undefined;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getConfig<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration("dev.containers").get<T>(key);
}

export async function getSettings(): Promise<Settings> {
    if (!_settings) {
        _settings = await (async () => {
            if (getExecCtx().kind !== ExecCtxKind.ExecServer) {
                getLogSink().info("Fetching local settings");
                return {
                    dockerPath: getConfig<string>("dockerPath") ?? "docker",
                    extraArgs: getConfig<string[]>("extraArgs") ?? [],
                    defaultExtensions: getConfig<string[]>("defaultExtensions") ?? [],
                };
            }
            else {
                return await getRemoteserverConfiguration();
            }
        })();
    }
    return _settings;
}

// TODO: remove after 0.8.0
const LEGACY_KEYS = ["engine", "extraArgs", "containerBinary"];

export function checkLegacySettings() {
    const legacy = vscode.workspace.getConfiguration("remote.devcontainer");
    const stale = LEGACY_KEYS.filter((k) => {
        const inspect = legacy.inspect(k);
        return inspect?.globalValue !== undefined || inspect?.workspaceValue !== undefined || inspect?.workspaceFolderValue !== undefined;
    });

    if (stale.length > 0) {
        void vscode.window.showWarningMessage(
            `Remote - Devcontainer: settings keys have changed. Please migrate: ${stale.map(k => `'remote.devcontainer.${k}'`).join(", ")}. See changelog or extension info for new keys.`,
            "Open Settings",
        ).then((choice) => {
            if (choice === "Open Settings") {
                vscode.commands.executeCommand("workbench.action.openSettings", "dev.containers");
            }
        });
    }
}
