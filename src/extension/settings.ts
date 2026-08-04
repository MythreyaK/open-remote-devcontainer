import * as vscode from "vscode";

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getConfig<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration("dev.containers").get<T>(key);
}

export function getContainerEngine(): string {
    return getConfig<string>("dockerPath") ?? "docker";
}

/**
 * returns `[engine, ...engine_args]` in `engine <engine_args...>
 * command <command args...>`
 *
 * e.g., `[ "podman", "--root", "<root dir>"]` for
 * `podman --root <root dir> command <command args>`
*/
export function getEngineCmd(): string[] {
    return [getContainerEngine(), ...getExtraArgs()];
}

function getExtraArgs(): string[] {
    return (getConfig<string[]>("extraArgs") ?? []);
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

export function getExtensionList(): string[] {
    return (getConfig<string[]>("defaultExtensions") ?? []);
}
