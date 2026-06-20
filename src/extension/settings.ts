import * as vscode from "vscode";

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getConfig<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration("remote.devcontainer").get<T>(key);
}

export function getContainerEngine(): string {
    return getConfig<string>("engine") || "docker";
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

export function getExtensionList(): string[] {
    return (getConfig<string[]>("defaultExtensions") ?? []);
}
