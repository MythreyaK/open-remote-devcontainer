import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import path, { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseEnv } from '../common/utils';
import { run } from '../common/cmd';
import { getLogSink } from '../extension/log';
import { ContainerConfig } from './container';
import { EngineError, InstallError, InternalError } from '../extension/error';
import { getWorkspaceId } from '../extension/workspace';

import * as settings from '../extension/settings';
import * as server from '../remote/installServer';

const DEVCONTAINER_SERVER_LISTEN_PORT = 65432;

const jsonFormat = ['--format', '{{json .}}'];

export class ContainerState {
    private readonly workspaceFolder: string;
    private readonly tempDir: string;
    private readonly devcontainerJson: string;
    private readonly cc: ContainerConfig;

    private containerId: string = "";
    private connectionToken: string = "";
    private remoteEnvProbe: Record<string, string> = {};
    // private imageId: string;

    private constructor(workspaceFolder: string, devcPath: string, cc: ContainerConfig) {
        this.workspaceFolder = path.resolve(workspaceFolder);
        this.tempDir = path.join(tmpdir(), `codium-devcontainer-${getWorkspaceId()}`);
        mkdirSync(this.tempDir, { recursive: true });

        getLogSink().info(`Created / using temp dir at ${this.tempDir}`);
        this.devcontainerJson = devcPath;
        this.cc = cc;
    }

    public static async create(workspaceFolder: string, devcPath: string, cc: ContainerConfig): Promise<ContainerState> {
        const ret = new ContainerState(workspaceFolder, devcPath, cc);

        ret.connectionToken = crypto.randomUUID();
        const containerExists = await ret.checkContainerExists(ret.getContainerName());
        if (containerExists === undefined) {
            await ret.createContainer();
        }
        else {
            ret.containerId = containerExists;
        }

        ret.remoteEnvProbe = await ret.getContainerEnv();

        return ret;
    }

    public getContainerId(): string {
        return this.containerId;
    }

    public getContainerName(): string {
        return `codium-devc-${getWorkspaceId()}`
    }

    public async checkContainerExists(name: string): Promise<string | undefined> {
        const ret = await run(
            [
                ...settings.getEngineCmd(),
                "container",
                "inspect",
                name,
                ...jsonFormat,
            ], {}
        );

        if (ret.exit !== 0) {
            return undefined;
        } else {
            return JSON.parse(ret.stdout.trim())["Id"];
        }
    }

    public async createContainer() {
        let imageName: string | undefined;

        if (this.cc.isDockerfileBased()) {
            const buildRes = await this.build(this.cc.getBuildCmd());
            if (buildRes.exit !== 0) {
                throw new EngineError(
                    `${settings.getContainerEngine()} build failed with error code ${buildRes.exit}:\n`
                    + `stdout: ${buildRes.stdout}\n`
                    + `stderr: ${buildRes.stderr}\n`
                );
            }
            else {
                imageName = this.cc.getImageName();
                getLogSink().info(`Image '${imageName}' (${buildRes.stdout}) built`);
            }
        }
        else if (this.cc.isImageBased()) {
            imageName = this.cc.cfg.image;
        }
        else {
            throw new InternalError("ContainerConfig isn't dockerfile or image based");
        }

        const imageRes = await this.getImage(imageName);
        if (imageRes.exit !== 0) {
            throw new EngineError(
                `${settings.getContainerEngine()} Image '${imageName}' does not exist:\n`
                + `stdout: ${imageRes.stdout.trim()}\n`
                + `stderr: ${imageRes.stderr.trim()}\n`
            );
        }
        const imageHash = imageRes.stdout.trim();

        const startRes = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getRunCreateCmd(imageName, this.getContainerName())
            ], {}
        );

        if (startRes.exit !== 0) {
            throw new EngineError(
                `Failed to start ${this.containerId}:\n`
                + `stdout: ${startRes.stdout}\n`
                + `stderr: ${startRes.stderr}\n`
            );
        }
        else {
            this.containerId = startRes.stdout.trim();
            getLogSink().info(`Started container from image ${imageName} (${imageHash}) with ID ${this.containerId}`);

        }

        return this.containerId;
    }

    public async getContainerEnv(): Promise<Record<string, string>> {
        // TODO: tty might cause issues?
        const out = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.containerId, {}, { tty: true, withRemoteEnv: false }),
                ...this.cc.getUserEnvProbeArgs(),
                "-c",
                "env -0",
            ],
            {});

        if (out.exit === 0) {
            const containerEnvs: Record<string, string> = parseEnv(out.stdout);
            return containerEnvs;
        }
        else { throw new EngineError("Could not run exec to probe container environment"); }
    }

    public getImage(name: string) {
        return run(
            [
                ...settings.getEngineCmd(),
                "image",
                "inspect",
                name,
                ...jsonFormat,
            ], {}
        );
    }

    public build(args: string[]) {
        // TODO: extend user's dockerfile? BASE_IMG?
        return run([...settings.getEngineCmd(), ...args], {});
    }

    public engineExec(cmdArgs: string[]) {
        return run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.containerId, this.remoteEnvProbe),
                ...cmdArgs
            ], {}
        );
    }

    public async installServer(forceReinstall: boolean = false) {
        // TODO: let users customize the URL
        const prodJson = await (async () => {
            const pj = await server.getProductJson();
            pj.serverUrlTemplate = pj.serverUrlTemplate
                .replace("${os}", "${CODIUM_OS_PLATFORM}")
                .replace("${arch}", "${CODIUM_ARCH}");
            return pj;
        })();

        const info: server.ScriptInstallInfo = {
            port: DEVCONTAINER_SERVER_LISTEN_PORT,
            extensions: settings.getExtensionList(),
            remoteEnvs: this.cc.getResolvedRemoteEnv(this.remoteEnvProbe),
            downloadTemplteUrl: prodJson.serverUrlTemplate,
            codiumVersion: prodJson.version,
            connectionToken: this.connectionToken,
            forceReinstall: forceReinstall,
        };

        const scriptData = await server.generateInstallScript(info, true);
        const installScriptPath = path.join(this.tempDir, "installScript.sh");
        writeFileSync(installScriptPath, scriptData, { encoding: 'utf-8' });

        const destFile = "/tmp/codium-devcontainer-installScript.sh";

        // TODO_IMMEDIATE: move to dockerfile
        const res = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.containerId, this.remoteEnvProbe),
                "bash",
                "-c",
                "apt update -y && apt install curl -y"
            ], {}
        );

        // copy the script and run it
        const copyResult = await run(
            [
                ...settings.getEngineCmd(),
                "cp",
                installScriptPath,
                `${this.containerId}:${destFile}`
            ], {}
        );

        if (copyResult.exit != 0) {
            throw new InstallError(`Could not copy install script from ${installScriptPath} (host) to ${this.containerId}:${destFile} (container)`);
        }

        const installExecResult = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.containerId, this.remoteEnvProbe),
                "bash",
                destFile
            ], {}
        );

        if (installExecResult.exit != 0) {
            const err = getInstallError(installExecResult.stdout);
            throw new InstallError(`Install script at ${this.containerId}:${destFile} failed with code ${installExecResult.exit}: Error: ${err}`);
        }

        return installExecResult;
    }
}

function getInstallError(data: string) {
    const errMsgMatches = Array.from(data.matchAll(/^INSTALL_SCRIPT_ERROR:(.*)$/gm));
    const errCodeMatches = Array.from(data.matchAll(/^EXITCODE\[\[(.*)\]\]$/gm));

    if (!errCodeMatches || !errMsgMatches) {
        throw new InstallError(`Could not extract error message from\n'${data}'`);
    }
    else {
        // TODO: error matching
        // const errMsg = errMsgMatches[0][1];
        // const errCode = errCodeMatches[0][1];
        // return `${errCode}${errMsg}`;
        return data;
    }

}
