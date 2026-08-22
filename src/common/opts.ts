import { LogOutputChannel } from "vscode";

export type Envs = Record<string, string | undefined>;

export interface SpawnOpts {
    env?: Envs,
    cwd?: string,
    stdin?: string | undefined,
    log: LogOutputChannel,
}

export interface RunOpts {
    cwd?: string,
    env?: Envs,
    stdin?: string | undefined,
}

export interface CmdResult {
    exit: number | NodeJS.Signals,
    stdout: string,
    stderr: string,
};
