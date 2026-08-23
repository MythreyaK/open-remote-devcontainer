import { RunOpts } from "./opts";
import { getLogSink } from "../extension/log";
import { getExecCtx } from "./ctx/ctx";

export async function run(cmdArgs: string[], opts: RunOpts) {
    getLogSink().debug(`cmd.run: [${cmdArgs.join(", ")}]: opts: ${JSON.stringify(opts)}`);
    return await getExecCtx().run(cmdArgs, opts);
}
