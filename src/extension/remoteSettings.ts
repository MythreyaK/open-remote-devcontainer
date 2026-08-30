import * as vscode from "vscode";
import path from "node:path";

import * as jc from "jsonc-parser";

import { getExecCtx } from "../common/ctx/ctx";
import { getProductJson, getRemoteAuthorities } from "../common/utils";
import { InternalError } from "./error";
import { getConfig, Settings } from "./settings";
import { findSSHServerInstallPath, SSHDestination } from "./ssh";
import { getLogSink } from "./log";

/**
 *
 * `vscode.workspace.getConfiguration` during execServer chaining reads only the
 * user config, not remote machine's. User may have configured different extension
 * settings there, so we must read those ourselves.
 * By default, for vscodium, it's at `$HOME/.vscodium-server/data/Machine/settings.json`
 * This path can be configured with `remote.SSH.serverInstallPath`, a key-value pair
 * of regex keys (for server/hostnames) and values as paths.
 *
 * TODO: Windows support, and merge local settings
 *
 * @returns `Settings` on the remote machine
 */
export async function getRemoteserverConfiguration(): Promise<Settings> {
    getLogSink().info(`Fetching remote settings '${vscode.env.remoteAuthority}'`);
    const productJson = await getProductJson();

    // get hostname from ssh
    // and chained is always at inx 1, that we chain to
    const auths = getRemoteAuthorities();
    const sshAuthority = auths[1];

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (auths === undefined || sshAuthority === undefined) {
        // man i dunno
        throw new InternalError("getRemoteserverConfiguration: Expected SSH authority to exist");
    }

    const hostname = SSHDestination.parse(sshAuthority).hostname;
    const remoteSysenv = await getExecCtx().env();

    if (!("HOME" in remoteSysenv.env)) {
        throw new InternalError("HOME was undefined on remote env");
    }
    const homedir = remoteSysenv.env.HOME;

    const DEFAULT_DIR = path.posix.join(homedir, productJson.serverDataFolderName);

    const readConfig = async (installPath: string): Promise<Settings> => {
        getLogSink().info(`getRemoteserverConfiguration: remote SSH install at: ${installPath}`);
        const cfgPath = path.posix.join(installPath, "data/Machine/settings.json");
        const raw = (await getExecCtx().fs.read(vscode.Uri.file(cfgPath))).trim();
        getLogSink().debug(`getRemoteserverConfiguration: raw cfg: ${raw}`);

        /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
        const remoteSettings = jc.parse(raw);
        return {
            dockerPath: remoteSettings["dev.containers.dockerPath"] ?? "docker",
            extraArgs: remoteSettings["dev.containers.extraArgs"] ?? [],
            defaultExtensions: remoteSettings["dev.containers.defaultExtensions"] ?? [],
        };
        /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
    };

    const serverInstallPathMap = vscode.workspace
        .getConfiguration("remote.SSH")
        .get<Record<string, string>>("serverInstallPath");

    // default is home if not configured
    const remoteInstallPath = findSSHServerInstallPath(sshAuthority, serverInstallPathMap ?? {});

    const logmsg = remoteInstallPath
        ? `serverInstallPath for host ${hostname} = ${remoteInstallPath}`
        : `no serverInstallPath for host ${hostname}, using default ${DEFAULT_DIR}`;

    getLogSink().info(`getRemoteserverConfiguration: remote.SSH.serverInstallPath[${hostname}]: ${logmsg}`);

    try {
        return await readConfig(remoteInstallPath ?? DEFAULT_DIR);
    }
    catch (e: unknown) {
        if (e instanceof Error) {
            getLogSink().error(`getRemoteserverConfiguration: returning local cfg, reading remote config failed: ${e.message}`);
        }
        else {
            getLogSink().error(`getRemoteserverConfiguration: returning local cfg, reading remote config failed with unknown error: ${JSON.stringify(e)}`);
        }
        return {
            dockerPath: getConfig<string>("dockerPath") ?? "docker",
            extraArgs: getConfig<string[]>("extraArgs") ?? [],
            defaultExtensions: getConfig<string[]>("defaultExtensions") ?? [],
        };
    }
}
