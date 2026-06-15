import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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

        getLogSink().info(`Created / using temp dir at ${this.tempDir}`);
        this.devcontainerJson = devcPath;
        this.cc = cc;
    }

    public static async create(workspaceFolder: string, devcPath: string, cc: ContainerConfig): Promise<ContainerState> {
        const ret = new ContainerState(workspaceFolder, devcPath, cc);

        ret.connectionToken = crypto.randomUUID();
        await ret.createContainer();
        return ret;
    }

    public getContainerId(): string {
        return this.containerId;
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

        const startRes = await run([...settings.getEngineCmd(), ...this.cc.getRunCreateCmd(imageName)], {});

        if (startRes.exit !== 0) {
            throw new EngineError(
                `${settings.getContainerEngine()} Image '${imageName}' does not exist:\n`
                + `stdout: ${startRes.stdout}\n`
                + `stderr: ${startRes.stderr}\n`
            );
        }
        else {
            this.containerId = startRes.stdout.trim();
            getLogSink().info(`Started container from image ${imageName} (${imageHash}) with ID ${this.containerId}`);

        }

        this.remoteEnvProbe = await this.getContainerEnv();

        return this.containerId;
    }

    public async getContainerEnv(): Promise<Record<string, string>> {
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
        else {throw new EngineError("Could not run exec to probe container environment");}
    }

    public getImage(name: string) {
        return run([...settings.getEngineCmd(), "image", "inspect", name], {});
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
                .replace("os", "CODIUM_OS_PLATFORM")
                .replace("arch", "CODIUM_ARCH");
            return pj;
        })();

        const info: server.ScriptInstallInfo = {
            port: DEVCONTAINER_SERVER_LISTEN_PORT,
            extensions: settings.getExtensionList(),
            remoteEnvs: this.remoteEnvProbe,
            downloadTemplteUrl: prodJson.serverUrlTemplate,
            codiumVersion: prodJson.version,
            connectionToken: this.connectionToken,
            forceReinstall: forceReinstall,
        };

        const scriptData = await server.generateInstallScript(info, false);
        const installScriptPath = path.join(this.tempDir, "installScript.sh");
        writeFileSync(installScriptPath, scriptData, { encoding: 'utf-8' });

        const destFile = `${this.containerId}:/tmp/codium-devcontainer-installScript.sh`;

        // copy the script and run it
        const copyResult = await run(
            [
                ...settings.getEngineCmd(),
                "cp",
                installScriptPath,
                destFile
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
            throw new InstallError(`Install script at ${this.containerId}:${destFile} failed with code ${installExecResult.exit}: Error: ${installExecResult.stderr}`);
        }

        return installExecResult;
    }
}
