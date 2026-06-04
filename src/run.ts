import * as chproc from 'node:child_process';
import { LogOutputChannel } from 'vscode';

export interface RunOptions {
    cwd: string,
    env: Map<string, string | undefined>,
    input?: string,
};

export interface CmdResult {
    exit: number | NodeJS.Signals,
    stdout: string,
    stderr: string,
};

export function runCmd(cmd: string, args: string[], opts: RunOptions, log: LogOutputChannel): Promise<CmdResult> {
    return new Promise((resolve, reject) => {
        let stdout: string = "";
        let stderr: string = "";

        // TODO: do we need env without inheriting parent's env?
        const finalEnv = {
            ...process.env,
            ...Object.fromEntries(opts.env),
        };

        const proc = chproc.spawn(cmd, args, {
            cwd: opts.cwd,
            env: finalEnv,
            stdio: 'pipe',
        });

        proc.on('spawn', () => {
            const strz_args = args.map((e) => `'${e}'`).join(" ");
            // TODO: log env values as well
            log.info(`Running ${cmd} ${strz_args}`);
        });

        proc.on('error', (err: Error) => {
            const res: CmdResult = {
                exit: 256,
                stdout: "<no output>",
                stderr: `${err.name}: ${err.message} : ${err.cause || "unknown cause"}`,
            };

            return reject(res);
        });

        proc.stdout.on('data', (_data) => {
            const data = _data.toString();
            stdout += data;
            log.info(data);
        });

        proc.stderr.on('data', (_data) => {
            const data = _data.toString();
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
                return reject(res);
            }

            return resolve(res);
        });
    });
}


