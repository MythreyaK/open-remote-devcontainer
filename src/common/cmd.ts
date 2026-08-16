import * as common from "./spawn";
import { getLogSink } from "../extension/log";

export interface RunOpts {
    cwd: string,
    env?: common.Envs | undefined,
    stdin?: string | undefined,
}

export async function run(cmdArgs: string[], opts: RunOpts) {
    return await common.spawn(cmdArgs[0], cmdArgs.slice(1), { cwd: opts.cwd, env: opts.env ?? {}, stdin: opts.stdin, log: getLogSink() });
}
