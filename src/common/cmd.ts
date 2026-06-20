import { workspace } from "vscode";

import * as common from "./spawn";
import { ConfigError } from "../extension/error";
import { getLogSink } from "../extension/log";

export async function runCmd(cmd: string, args: string[], cwd: string, env: common.Envs) {
    const folders = workspace.workspaceFolders;

    if (!folders || folders.length === 0) {
        throw new ConfigError("Not in a devcontainer workspace");
    }
    else {
        return await common.spawn(cmd, args, cwd, env, getLogSink());
    }
}

export async function run(cmdArgs: string[], cwd: string, env: common.Envs) {
    return await common.spawn(cmdArgs[0], cmdArgs.slice(1), cwd, env, getLogSink());
}
