import * as vscode from "vscode";

export interface Settings {
    dockerPath: string,
    extraArgs: string[],
    defaultExtensions: string[],
}

function getDefaults(): Settings {
    return {
        dockerPath: "docker",
        extraArgs: [],
        defaultExtensions: [],
    };
}

export function withDefaults(queried: Partial<Settings>): Settings {
    const defaults = getDefaults();
    return {
        dockerPath: queried.dockerPath ?? defaults.dockerPath,
        extraArgs: queried.extraArgs ?? defaults.extraArgs,
        defaultExtensions: queried.defaultExtensions ?? defaults.defaultExtensions,
    };
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function getConfig<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration("dev.containers").get<T>(key);
}
