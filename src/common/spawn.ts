import { StringDecoder } from "node:string_decoder";
import { CmdResult, RunOpts } from "./opts";
import { getLogSink } from "../extension/log";
import type { SpawnedProcess } from "./ctx/execCtx";

let cmdCount: number = 0;

export function collectOutput(proc: SpawnedProcess, opts?: RunOpts): Promise<CmdResult> {
    return new Promise((resolve) => {
        cmdCount += 1;
        const cmdId = cmdCount;
        const log = getLogSink();
        const tag = `CMD${String(cmdId).padStart(4, "0")}`;

        let stdout = "";
        let stderr = "";
        const stdoutDecoder = new StringDecoder("utf-8");
        const stderrDecoder = new StringDecoder("utf-8");

        if (opts?.stdin !== undefined) {
            proc.stdin.write(Buffer.from(opts.stdin));
            proc.stdin.end();
        }

        proc.onStdout((d) => {
            const chunk = stdoutDecoder.write(d);
            stdout += chunk;
            log.debug(`${tag} stdout: ${chunk.trimEnd()}`);
        });

        proc.onStderr((d) => {
            const chunk = stderrDecoder.write(d);
            stderr += chunk;
            log.debug(`${tag} stderr: ${chunk.trimEnd()}`);
        });

        proc.onError((err) => {
            log.error(`${tag} error: ${err.message}`);
            resolve({ exit: 255, stdout: "", stderr: err.message });
        });

        let exitCode: number = 256;

        proc.onExit((code) => {
            exitCode = code ?? 256;
            if (exitCode !== 0) {
                log.error(`${tag} exited ${exitCode}`);
            }
        });

        proc.onClose(() => {
            stdout += stdoutDecoder.end();
            stderr += stderrDecoder.end();
            resolve({ exit: exitCode, stdout, stderr });
        });
    });
}

export function formatCmdErr(res: CmdResult): string {
    return `Error: ${res.exit}: stdout: [${res.stdout.trim()}] stderr: [${res.stderr.trim()}]`;
}
