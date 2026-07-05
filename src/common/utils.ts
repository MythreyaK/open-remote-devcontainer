import { runCmd } from "../common/cmd";
import { formatCmdErr } from "../common/spawn";
import { SpawnError } from "../extension/error";
import { getLocalWorkspaceFolder } from "../extension/workspace";

export interface HostUserInfo {
    uid: number,
    gid: number,
    name: string,
};

/**
 *
 * @param envStdout null-char (env -0) seperated list of env vars
 * @returns Record<string, string | undefined>
 */
export function parseEnv(envStdout: string) {
    /* eslint-disable @stylistic/quotes */
    const envs: string[] = envStdout.split('\0').filter(Boolean);
    const parsesEnvs: Record<string, string> = {};

    for (const env of envs) {
        const items = env.split('=');
        const [k, v] = [items[0], items.slice(1).join('=')];
        parsesEnvs[k] = v;
    }
    return parsesEnvs;
    /* eslint-enable @stylistic/quotes */
}

export async function getHostUserInfo(cwd: string = getLocalWorkspaceFolder()): Promise<HostUserInfo> {
    const userName = await runCmd("/bin/sh", ["-c", "id -n -u $UID"], cwd, {});
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
