import { run } from "../common/cmd";
import { formatCmdErr } from "../common/spawn";
import { SpawnError } from "../extension/error";

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
    const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

    /* eslint-disable @stylistic/quotes */
    const envs: string[] = envStdout.split('\0').filter(Boolean);
    const parsedEnvs: Record<string, string> = {};

    for (const env of envs) {
        const eqIdx = env.indexOf('=');
        if (eqIdx === -1) { continue; }

        const k = env.slice(0, eqIdx);
        const v = env.slice(eqIdx + 1);

        if (!ENV_KEY_REGEX.test(k)) { continue; }

        parsedEnvs[k] = v;
    }
    return parsedEnvs;
    /* eslint-enable @stylistic/quotes */
}

export async function getHostUserInfo(): Promise<HostUserInfo> {
    const userName = await run(["/bin/sh", "-c", "id -n -u $UID"], {});
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
