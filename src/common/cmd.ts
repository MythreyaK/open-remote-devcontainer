import { workspace } from "vscode";

import * as common from "./spawn";
import { getLogSink } from "../extension/log";

export async function runCmd(cmd: string, args: string[], cwd: string, env: common.Envs) {
    return await common.spawn(cmd, args, cwd, env, getLogSink());
}

export async function run(cmdArgs: string[], cwd: string, env: common.Envs) {
    return await common.spawn(cmdArgs[0], cmdArgs.slice(1), cwd, env, getLogSink());
}
