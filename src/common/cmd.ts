import * as common from "./spawn";
import { RunOpts } from "./opts";
import { getLogSink } from "../extension/log";

export async function run(cmdArgs: string[], opts: RunOpts) {
    getLogSink().trace(`cmd.run: [${cmdArgs.join(", ")}]: opts: ${JSON.stringify(opts)}`);
    return await common.spawn(cmdArgs[0], cmdArgs.slice(1), { ...opts, log: getLogSink() });
}
