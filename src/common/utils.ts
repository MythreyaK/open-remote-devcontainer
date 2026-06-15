
/**
 *
 * @param envStdout null-char (env -0) seperated list of env vars
 * @returns Record<string, string | undefined>
 */
export function parseEnv(envStdout: string) {
    const envs: string[] = envStdout.split('\0').filter(Boolean);
    const parsesEnvs: Record<string, string> = {};

    for (const env of envs) {
        const items = env.split('=');
        const [k, v] = [items[0], items.slice(1).join('=')];
        parsesEnvs[k] = v;
    }
    return parsesEnvs;
}
