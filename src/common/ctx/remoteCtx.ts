import * as vscode from "vscode";

import { RunCtx } from "./runctx";
import { HostUserInfo } from "../utils";
import { formatCmdErr } from "../spawn";
import { getLogSink } from "../../extension/log";
import { SpawnError } from "../../extension/error";
import { CmdResult, RunOpts } from "../opts";

let cmdCount: number = 0;

export class ExecRemoteRunCtx implements RunCtx {
    constructor(
        private readonly execServer: vscode.ExecServer,
    ) { }

    async run(cmdArgs: string[], opts: RunOpts): Promise<CmdResult> {
        cmdCount += 1;
        const cmdId = cmdCount;
        const cmdStr = () => `[CMD${String(cmdId).padStart(4, "0")}]:`;

        const [cmd, ...args] = cmdArgs;
        const log = getLogSink();
        log.info(`RemoteRunCtx.spawn[${cmdStr()}]: [${cmdArgs.join(", ")}]`);

        const env: Record<string, string> = opts.env
            ? Object.fromEntries(
                Object.entries(opts.env)
                    .filter((e): e is [string, string] => e[1] !== undefined),
            )
            : {};

        const spawned = await this.execServer.spawn(cmd, args, {
            cwd: opts.cwd,
            env: env,
        });

        if (opts.stdin !== undefined) {
            spawned.stdin.write(new TextEncoder().encode(opts.stdin));
            spawned.stdin.end();
        }

        let stdout = "";
        let stderr = "";
        const decoder = new TextDecoder("utf-8");

        spawned.stdout.onDidReceiveMessage((data: Uint8Array) => {
            const chunk = decoder.decode(data, { stream: true });
            stdout += chunk;
            log.error(`RemoteRunCtx.stdout.onDidReceiveMessage[${cmdStr()}]: len ${chunk.length}`, chunk);
        });

        spawned.stderr.onDidReceiveMessage((data: Uint8Array) => {
            const chunk = decoder.decode(data, { stream: true });
            stderr += chunk;
            log.trace(`RemoteRunCtx.stderr.onDidReceiveMessage[${cmdStr()}]: len ${chunk.length}`, chunk);
        });

        const exit = await spawned.onExit;

        return { exit: exit.status, stdout, stderr };
    }

    async getHostUserInfo(): Promise<HostUserInfo> {
        const uid = await this.run(["id", "-u"], {});
        const gid = await this.run(["id", "-g"], {});
        const username = await this.run(["id", "-un"], {});

        if (uid.exit !== 0 || gid.exit !== 0) {
            throw new SpawnError(`RemoteRunCtx.getHostUserInfo: Could not query remote host user info: uid: ${formatCmdErr(uid)} gid: ${formatCmdErr(gid)}`);
        }

        if (username.exit !== 0) {
            getLogSink().warn(`RemoteRunCtx.getHostUserInfo: Could not query remote host user info: ${formatCmdErr(username)}`);
        }

        return {
            uid: parseInt(uid.stdout.trim(), 10),
            gid: parseInt(gid.stdout.trim(), 10),
            name: username.stdout.trim(),
        };
    }
}
