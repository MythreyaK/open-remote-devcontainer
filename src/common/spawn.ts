import * as chproc from 'node:child_process';
import { LogOutputChannel } from 'vscode';

export type Envs = Record<string, string | undefined>;

export interface CmdResult {
    exit: number | NodeJS.Signals,
    stdout: string,
    stderr: string,
};

export class CmdError extends Error {
    constructor(
        public readonly exit: number | NodeJS.Signals,
        public readonly stdout: string,
        public readonly stderr: string,
    ) {
        super(`exit ${exit.toString()}: ${stderr.slice(0, 200)}`);
    }
}

/* eslint-disable @typescript-eslint/no-confusing-void-expression */
export function spawn(
    cmd: string,
    args: string[],
    cwd: string,
    env: Envs,
    log: LogOutputChannel
): Promise<CmdResult> {
    return new Promise((resolve, reject) => {
        let stdout: string = "";
        let stderr: string = "";

        // TODO: do we need env without inheriting parent's env?
        const finalEnv = {
            ...process.env,
            ...env
        };

        const proc = chproc.spawn(cmd, args, {
            cwd: cwd,
            env: finalEnv,
            stdio: 'pipe',
        });
        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');

        proc.on('spawn', () => {
            const strz_args = args.map((e) => `'${e}'`).join(", ");
            // TODO: log env values as well
            log.info(`Running (spawn) ['${cmd}', ${strz_args}]`);
        });

        proc.on('error', (err: Error) => {
            let cause = "<unknown cause>";
            if (err.cause) {
                cause = JSON.stringify(err.cause);
            }

            return reject(new CmdError(256, "<no output>", `${err.name}: ${err.message} : ${cause}`));
        });

        proc.stdout.on('data', (data: string) => {
            stdout += data;
            log.info(data);
        });

        proc.stderr.on('data', (data: string) => {
            stderr += data;
            log.error(data);
        });

        proc.on('exit', (code, signal) => {
            const res: CmdResult = {
                exit: code ?? (signal ?? 256),
                stdout: stdout,
                stderr: stderr,
            };

            if ((code !== null && code !== 0) || (signal)) {
                return reject(new CmdError(code ?? (signal ?? 256), stdout, stderr));
            }

            return resolve(res);
        });
    });
}
/* eslint-enable @typescript-eslint/no-confusing-void-expression */

