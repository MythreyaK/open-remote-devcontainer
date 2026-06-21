import path from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";

import { run } from "../common/cmd";
import { parseEnv } from "../common/utils";
import { getLogSink } from "../extension/log";
import { ContainerConfig } from "./container";
import { getWorkspaceId } from "../extension/workspace";
import { EngineError, InstallError, InternalError } from "../extension/error";

import * as settings from "../extension/settings";
import * as server from "../remote/installServer";
import { CmdResult } from "../common/spawn";

const DEVCONTAINER_SERVER_LISTEN_PORT = 65432;
const UUID_TOKEN_LEN = 36;

const jsonFormat = ["--format", "{{json .}}"];

export interface ContainerInspectResult {
    Id: string,
    State: {
        Status: "created" | "running" | "paused" | "stopped" | "exited",
        Running: boolean,
    },
};

export class ContainerState {
    private readonly workspaceFolder: string;
    private readonly tempDir: string;
    private readonly cc: ContainerConfig;

    private remoteEnvProbe: Record<string, string> = {};
    // private imageId: string;

    private constructor(workspaceFolder: string, cc: ContainerConfig) {
        this.workspaceFolder = path.resolve(workspaceFolder);
        this.tempDir = path.join(tmpdir(), `codium-devcontainer-${getWorkspaceId(this.workspaceFolder)}`);
        mkdirSync(this.tempDir, { recursive: true });

        getLogSink().info(`Created / using temp dir at ${this.tempDir}`);
        this.cc = cc;
    }

    public static async create(workspaceFolder: string, cc: ContainerConfig): Promise<ContainerState> {
        const ret = new ContainerState(workspaceFolder, cc);

        const containerExists = await ret.containerExists(ret.getContainerName());
        let containerId: string | undefined;

        if (containerExists === undefined) {
            containerId = await ret.createContainer();
            if (!await ret.isRunning()) {
                throw new Error(`Could not start container ${ret.getContainerName()}`);
            }
        }
        else if (!containerExists.State.Running) {
            containerId = await ret.startContainer();
        }
        else {
            containerId = containerExists.Id;
        }

        if (!containerId) {
            throw new Error("Could not start container. Check logs");
        }

        ret.remoteEnvProbe = await ret.getContainerEnv();
        return ret;
    }

    public getConfig(): ContainerConfig {
        return this.cc;
    }

    public async getContainerId(): Promise<string> {
        const ret = await this.inspectContainer(this.getContainerName());
        return ret.Id;
    }

    public static getContainerName(wsf: string): string {
        return `codium-devc-${getWorkspaceId(wsf)}`;
    }

    public getContainerName(): string {
        return `codium-devc-${getWorkspaceId(this.workspaceFolder)}`;
    }

    private async createContainer() {
        let imageName: string | undefined;

        if (this.cc.isDockerfileBased()) {
            const buildRes = await this.build(this.cc.getBuildCmd());
            if (buildRes.exit !== 0) {
                throw new EngineError(`${settings.getContainerEngine()} build failed ${formatCmdErr(buildRes)}`);
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

        const imageHash = await (async () => {
            const imageRes = await this.getImage(imageName);
            if (imageRes.exit === 0) {
                // image exists, just return that hash
                return imageRes.stdout.trim();
            }
            else {
                // attempt to pull the image
                getLogSink().warn(`Image '${imageName}' does not exist, attempting to pull ...`);
                const pullRes = await run([
                    ...settings.getEngineCmd(),
                    "pull",
                    imageName,
                ], this.workspaceFolder, {});

                if (pullRes.exit !== 0) {
                    throw new EngineError(`Failed to pull image ${imageName}. Image '${imageName}' does not exist on host.`);
                }

                // pull was successful, image hash is whatever pull has
                return pullRes.stdout.trim();
            }
        })();

        if (!imageHash) {
            throw new Error("Invalid image hash. This is a bug, please report it");
        }

        return await this.runCreate(imageName, imageHash);
    }

    public async isRunning(): Promise<boolean> {
        const ret = await this.inspectContainer(this.getContainerName());
        return ret.State.Running;
    }

    private async startContainer(): Promise<string> {
        const ret = await run([
            ...settings.getEngineCmd(),
            "start",
            this.getContainerName(),
        ], this.workspaceFolder, {});

        if (ret.exit !== 0) {
            throw new EngineError(`Failed to start container: ${formatCmdErr(ret)}`);
        }
        else {
            return ret.stdout.trim();
        }
    }

    public async stopContainer() {
        const ret = await run([
            ...settings.getEngineCmd(),
            "stop",
            this.getContainerName(),
        ], this.workspaceFolder, {});

        if (ret.exit !== 0) {
            throw new EngineError(`Failed to stop container: ${formatCmdErr(ret)}`);
        }
        else {
            return ret.stdout.trim();
        }
    }

    private async inspectContainer(identifier: string): Promise<ContainerInspectResult> {
        const res = await run(
            [
                ...settings.getEngineCmd(),
                "container",
                "inspect",
                identifier,
                ...jsonFormat,
            ], this.workspaceFolder, {},
        );

        if (res.exit !== 0) {
            throw new EngineError(`Could not inspect ${this.getContainerName()}: ${formatCmdErr(res)}`);
        }
        else {
            return JSON.parse(res.stdout.trim()) as ContainerInspectResult;
        }
    }

    public async containerExists(identifier: string): Promise<ContainerInspectResult | undefined> {
        const res = await run(
            [
                ...settings.getEngineCmd(),
                "container",
                "inspect",
                identifier,
                ...jsonFormat,
            ], this.workspaceFolder, {},
        );

        if (res.exit !== 0) {
            return undefined;
        }
        else {
            return JSON.parse(res.stdout.trim()) as ContainerInspectResult;
        }
    }

    /**
     * Container must be running before calling this. Throws otherwise.
     *
     * @returns Connection token that is used for authenticating with server.
     */
    public async getConnectionToken(): Promise<string> {
        const checkExists = await this.containerExists(this.getContainerName());
        if (checkExists !== undefined && checkExists.State.Running) {
            // TODO: token in tempdir?
            const token = await run([
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), this.remoteEnvProbe),
                "bash",
                "-c",
                "cat ${HOME}/.vscode-oss-devcontainer/token",
            ], this.workspaceFolder, {});

            if (token.exit !== 0 || token.stdout.trim().length !== UUID_TOKEN_LEN) {
                // TODO: reinstall server? force-restart with new token?
                throw new InstallError(`Could not query token in container [stdout:${token.stdout}] [stderr:${token.stderr}]`);
            }
            return token.stdout.trim();
        }
        else {
            throw new Error(`Container ${this.getContainerName()} does not exist or is not running: (state: ${JSON.stringify(checkExists?.State)})`);
        }
    }

    private async runCreate(imageName: string, imageHash: string): Promise<string> {
        // TODO: auto-assign free port and query
        const createRes = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getRunCreateCmd(
                    imageName,
                    this.getContainerName(),
                    ["-p", `${DEVCONTAINER_SERVER_LISTEN_PORT}:${DEVCONTAINER_SERVER_LISTEN_PORT}`],
                ),
            ], this.workspaceFolder, {},
        );

        if (createRes.exit !== 0) {
            throw new EngineError(
                `Failed to start ${this.getContainerName()}:\n`
                + `stdout: ${createRes.stdout}\n`
                + `stderr: ${createRes.stderr}\n`,
            );
        }
        else {
            getLogSink().info(`Started container ${this.getContainerName()} from image ${imageName} (${imageHash})`);
        }

        return createRes.stdout.trim();
    }

    private static assertSet(tok: string | undefined, msg: string): asserts tok is string {
        if (!tok) { throw new Error(msg); }
    }

    public async getContainerEnv(): Promise<Record<string, string>> {
        // TODO: tty might cause issues?
        const out = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), {}, { tty: true, withRemoteEnv: false }),
                ...this.cc.getUserEnvProbeArgs(),
                "-c",
                "env -0",
            ], this.workspaceFolder, {});

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
            ], this.workspaceFolder, {},
        );
    }

    private build(args: string[]) {
        // TODO: extend user's dockerfile? BASE_IMG?
        return run([...settings.getEngineCmd(), ...args], this.workspaceFolder, {});
    }

    public engineExec(cmdArgs: string[]) {
        return run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), this.remoteEnvProbe),
                ...cmdArgs,
            ], this.workspaceFolder, {},
        );
    }

    public async installServer(forceReinstall: boolean = false) {
        if (!await this.isRunning()) {
            if (!await this.startContainer() && !await this.isRunning()) {
                throw new Error("Failed to start container. Check logs");
            }
        }

        // TODO: let users customize the URL
        const prodJson = await (async () => {
            const pj = await server.getProductJson();
            pj.serverUrlTemplate = pj.serverUrlTemplate
                .replace("${os}", "${CODIUM_OS_PLATFORM}")
                .replace("${arch}", "${CODIUM_ARCH}");
            return pj;
        })();

        let token: string | undefined;

        try {
            token = await this.getConnectionToken();
        }
        catch {
            getLogSink().warn("Could not query existing token. Perhaps a fresh install? Using a new token");
            forceReinstall = true;
            token = crypto.randomUUID();
        }

        const info: server.ScriptInstallInfo = {
            port: DEVCONTAINER_SERVER_LISTEN_PORT,
            extensions: settings.getExtensionList(),
            remoteEnvs: this.cc.getResolvedRemoteEnv(this.remoteEnvProbe),
            downloadTemplteUrl: prodJson.serverUrlTemplate,
            codiumVersion: prodJson.version,
            connectionToken: token,
            forceReinstall: forceReinstall,
        };

        const scriptData = await server.generateInstallScript(info, true);
        const installScriptPath = path.join(this.tempDir, "installScript.sh");
        writeFileSync(installScriptPath, scriptData, { encoding: "utf-8" });

        const destFile = "/tmp/codium-devcontainer-installScript.sh";

        // TODO_IMMEDIATE: move to dockerfile
        const _res = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), this.remoteEnvProbe),
                "bash",
                "-c",
                "apt update -y && apt install curl -y",
            ], this.workspaceFolder, {},
        );
        void _res;

        // copy the script and run it
        const copyResult = await run(
            [
                ...settings.getEngineCmd(),
                "cp",
                installScriptPath,
                `${this.getContainerName()}:${destFile}`,
            ], this.workspaceFolder, {},
        );

        if (copyResult.exit !== 0) {
            throw new InstallError(`Could not copy install script from ${installScriptPath} (host) to ${this.getContainerName()}:${destFile} (container)`);
        }

        const installExecResult = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getExecArgs(this.getContainerName(), this.remoteEnvProbe),
                "bash",
                destFile,
            ], this.workspaceFolder, {},
        );

        if (installExecResult.exit !== 0) {
            const err = getInstallError(installExecResult.stdout);
            throw new InstallError(`Install script at ${this.getContainerName()}:${destFile} failed with code ${installExecResult.exit}: Error: ${err}`);
        }

        return { host: "127.0.0.1", port: DEVCONTAINER_SERVER_LISTEN_PORT, result: installExecResult };
    }
}

function getInstallError(data: string) {
    const errMsgMatches = Array.from(data.matchAll(/^INSTALL_SCRIPT_ERROR:(.*)$/gm));
    const errCodeMatches = Array.from(data.matchAll(/^EXITCODE\[\[(.*)\]\]$/gm));

    if (errCodeMatches.length === 0 || errMsgMatches.length === 0) {
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

function formatCmdErr(res: CmdResult) {
    return `Error: ${res.exit}: stdout: [${res.stdout.trim()}] stderr: [${res.stderr.trim()}]`;
}
