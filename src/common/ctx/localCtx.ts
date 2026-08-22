import { RunCtx } from "./runctx";
import { HostUserInfo } from "../utils";
import { formatCmdErr, spawn } from "../spawn";
import { getLogSink } from "../../extension/log";
import { SpawnError } from "../../extension/error";
import { CmdResult, RunOpts } from "../opts";

export class LocalRunCtx implements RunCtx {
    async run(cmdArgs: string[], opts: RunOpts): Promise<CmdResult> {
        return await spawn(cmdArgs[0], cmdArgs.slice(1), { ...opts, log: getLogSink() });
    }

    async getHostUserInfo(): Promise<HostUserInfo> {
        const userName = await spawn("id", ["-nu"], { log: getLogSink() });
        /* eslint-disable @typescript-eslint/no-non-null-assertion */
        if (userName.exit === 0) {
            return {
                uid: process.getuid!(),
                gid: process.getgid!(),
                name: userName.stdout.trim(),
            };
        }
        else {
            throw new SpawnError(`Could not query host user info (uid, gid, name): ${formatCmdErr(userName)}`);
        }
        /* eslint-enable @typescript-eslint/no-non-null-assertion */
    }
}
