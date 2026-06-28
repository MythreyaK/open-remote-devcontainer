import { LogOutputChannel } from "vscode";
import * as chproc from "node:child_process";

export type Envs = Record<string, string | undefined>;

export interface CmdResult {
    exit: number | NodeJS.Signals,
    stdout: string,
    stderr: string,
};

let cmdCount: number = 1;

/* eslint-disable @typescript-eslint/no-confusing-void-expression */
export function spawn(
    cmd: string,
    args: string[],
    cwd: string,
    env: Envs,
    log: LogOutputChannel,
): Promise<CmdResult> {
    return new Promise((resolve, _) => {
        cmdCount += 1;
        const cmdId = cmdCount;

        const cmdStr = () => `[CMD${String(cmdId).padStart(4, "0")}]:`;

        let stdout: string = "";
        let stderr: string = "";

        // TODO: do we need env without inheriting parent's env?
        const finalEnv = {
            ...process.env,
            ...env,
        };

        const proc = chproc.spawn(cmd, args, {
            cwd: cwd,
            env: finalEnv,
            stdio: "pipe",
        });
        proc.stdout.setEncoding("utf-8");
        proc.stderr.setEncoding("utf-8");

        proc.on("spawn", () => {
            const strz_args = args.map(e => `'${e}'`).join(", ");
            // TODO: log env values as well
            log.info(`${cmdStr()} Running (spawn) ['${cmd}', ${strz_args}]`);
        });

        proc.on("error", (err: NodeJS.ErrnoException) => {
            const msg = `${err.code} :: ${err.message} :: :: ${err.syscall}`;
            const res: CmdResult = {
                exit: err.errno ?? 255,
                stdout: "",
                stderr: err.message,
            };

            log.error(cmdStr(), msg);
            // TODO: reject?
            return resolve(res);
        });

        proc.stdout.on("data", (data: string) => {
            stdout += data;
            log.info(cmdStr(), data);
        });

        proc.stderr.on("data", (data: string) => {
            stderr += data;
            log.error(cmdStr(), data);
        });

        proc.on("exit", (code, signal) => {
            const res: CmdResult = {
                exit: code ?? (signal ?? 256),
                stdout: stdout,
                stderr: stderr,
            };

            if (code !== 0) {
                log.error(`${cmdStr()} Command failed with {code / signal ${res.exit}}`);
            }
            else {
                log.info(`${cmdStr()} command exit: ${res.exit}`);
            }

            return resolve(res);
        });
    });
}
/* eslint-enable @typescript-eslint/no-confusing-void-expression */

export function formatCmdErr(res: CmdResult): string {
    return `Error: ${res.exit}: stdout: [${res.stdout.trim()}] stderr: [${res.stderr.trim()}]`;
}
