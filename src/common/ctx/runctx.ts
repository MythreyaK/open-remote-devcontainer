import { HostUserInfo } from "../utils";
import { CmdResult, RunOpts } from "../opts";

export interface RunCtx {
    run(cmdArgs: string[], opts: RunOpts): Promise<CmdResult>,
    getHostUserInfo(): Promise<HostUserInfo>,
}
