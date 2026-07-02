import path from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";

import { run } from "../common/cmd";
import { parseEnv } from "../common/utils";
import { getLogSink } from "../extension/log";
import { ContainerConfig } from "./container";
import { formatCmdErr } from "../common/spawn";
import { getWorkspaceId, NotificationLevel, showNotification } from "../extension/workspace";
import { EngineError, InstallError, InternalError } from "../extension/error";

import * as settings from "../extension/settings";
import * as server from "../remote/installServer";
import { getContainerEngine } from "../extension/settings";

const DEVCONTAINER_SERVER_LISTEN_PORT = 65432;
const UUID_TOKEN_LEN = 36;

const jsonFormat = ["--format", "{{json .}}"];

export interface ContainerInspectResult {
    Id: string,
    Name: string,
    State: {
        Status: "created" | "running" | "paused" | "stopped" | "exited",
        Running: boolean,
    },
    Mounts: {
        Type: string,
        Source: string,
        Destination: string,
        Driver: string,
        Mode: string,
        Options: string[],
        RW: boolean,
        Propagation: "shared" | "slave" | "private" | "unbindable" | "rshared" | "rslave" | "runbindable" | "rprivate",
    }[],
};

export interface ImageInspectResult {
    Id: string,
    Name: string,
    User: string | undefined,
};

export enum BuildOpts {
    Default = "default",
    Rebuild = "rebuild",
    RebuildNoCache = "rebuildNoCache",
};

export class ContainerState {
    private readonly workspaceFolder: string;
    private readonly cc: ContainerConfig;
    private readonly tempDir: string;
    private readonly buildOpts: BuildOpts;

    private remoteEnvProbe: Record<string, string> = {};
    // private imageId: string;

    private constructor(workspaceFolder: string, cc: ContainerConfig, opts: BuildOpts = BuildOpts.Default) {
        this.workspaceFolder = path.resolve(workspaceFolder);
        this.cc = cc;
        this.buildOpts = opts;

        this.tempDir = path.join(tmpdir(), `codium-devcontainer-${getWorkspaceId(this.workspaceFolder)}`);
        mkdirSync(this.tempDir, { recursive: true });
        getLogSink().info(`Created / using temp dir at ${this.tempDir}`);
    }

    public static async create(workspaceFolder: string, cc: ContainerConfig, opts: BuildOpts = BuildOpts.Default): Promise<ContainerState> {
        const ret = new ContainerState(workspaceFolder, cc, opts);

        if (opts !== BuildOpts.Default) {
            getLogSink().info(`'${opts}' requested  ...`);
            await ret.tryStopContainer();
            await ret.removeContainer();
        }

        const containerExists = await ret.tryContainerInspect(ret.getContainerName());
        let containerId: string | undefined;

        if (opts !== BuildOpts.Default && containerExists !== undefined) {
            throw new EngineError(`Failed to stop and remove container ${containerExists.Id}`);
        }

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
        const name = await this.buildFinalImage();
        return await this.runCreate(name);
    }

    private async buildFinalImage(): Promise<string> {
        let stage1Image: string | undefined;

        if (this.cc.isDockerfileBased()) {
            const name = await this.buildUserImage();
            stage1Image = name;
        }
        else if (this.cc.isImageBased()) {
            stage1Image = this.cc.cfg.image;

            // ensure image exists
            const img = await this.tryInspectImage(stage1Image);

            if (!img || this.buildOpts !== BuildOpts.Default) {
                // attempt to pull image
                const imageHash = await (async () => {
                    getLogSink().warn(`Image '${stage1Image}' does not exist or noCache specified, attempting to pull ...`);
                    const pullRes = await run([
                        ...settings.getEngineCmd(),
                        "pull",
                        stage1Image,
                    ], this.workspaceFolder, {});

                    if (pullRes.exit !== 0) {
                        throw new EngineError(`Failed to pull image ${stage1Image}. Image '${stage1Image}' does not exist on host.`);
                    }
                    // pull was successful, image hash is whatever pull has
                    return pullRes.stdout.trim();
                })();
                getLogSink().info(`Pulled image '${stage1Image}' (${imageHash})`);
            }
        }
        else {
            throw new InternalError("ContainerConfig isn't dockerfile or image based");
        }

        getLogSink().info(`Building stage2 image from ${stage1Image}`);

        return await this.buildStage2(stage1Image);
    }

    private async buildStage2(stage1Image: string): Promise<string> {
        const imgUser = await run([
            ...settings.getEngineCmd(),
            "image",
            "inspect",
            stage1Image,
            ...jsonFormat,
        ], this.workspaceFolder, {});

        if (imgUser.exit !== 0) {
            throw new EngineError(`Could not query ${stage1Image} User field. ${formatCmdErr(imgUser)}`);
        }

        const imageUser = (() => {
            const parsed = fixDockerImageInspect(imgUser.stdout.trim());
            if (!parsed.User) { return undefined; }
            else { return parsed.User; }
        })();

        const remoteUser = this.cc.getResolvedRemoteUser(imageUser);

        if (remoteUser === "root") {
            const msg = "Warning: remote user not specified, using 'root'. This may cause permission issues.";
            getLogSink().warn(msg);
            showNotification(NotificationLevel.Warning, msg);
        }

        const ret = await run([
            ...settings.getEngineCmd(),
            ...(await this.cc.getStage2BuildCmd(imageUser, { noCache: this.buildOpts === BuildOpts.RebuildNoCache })),
        ], this.workspaceFolder, {});

        if (ret.exit !== 0) {
            const errMsg = Array.from(ret.stderr.trim().matchAll(/{{DEVCONTAINER_STAGE2 ERROR: (.*?)}}/g));
            if (errMsg.length !== 1 || errMsg[0].length < 2) {
                throw new Error(`Could not build stage2 image with unknown error: ${formatCmdErr(ret)}`);
            }
            else {
                throw new EngineError(`Could not build stage2 image: ${errMsg[0][1]}`);
            }
        }
        else {
            return this.cc.getStage2ImageName();
        }
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

    public async tryStopContainer() {
        const ret = await run([
            ...settings.getEngineCmd(),
            "stop",
            this.getContainerName(),
        ], this.workspaceFolder, {});
        return ret;
    }

    public async stopContainer() {
        const ret = await this.tryStopContainer();

        if (ret.exit !== 0) {
            throw new EngineError(`Could not stop container: ${formatCmdErr(ret)}`);
        }

        return ret.stdout.trim();
    }

    public async removeContainer() {
        const ret = await this.tryRemoveContainer();
        if (ret.exit !== 0) {
            getLogSink().error(`Could not remove container ${ret.exit}: ${ret.stderr.trim()}, forcing ...`);
            const fRet = await this.tryRemoveContainer({ force: true });
            return fRet.stdout.trim();
        }
        else {
            return ret.stdout.trim();
        }
    }

    public async tryRemoveContainer(opts: { force: boolean } = { force: false }) {
        const ret = await run([
            ...settings.getEngineCmd(),
            "rm",
            ...(opts.force ? ["--force"] : []),
            this.getContainerName(),
        ], this.workspaceFolder, {});
        return ret;
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
            throw new EngineError(`Could not inspect container '${identifier}': ${formatCmdErr(res)}`);
        }
        else {
            return JSON.parse(res.stdout.trim()) as ContainerInspectResult;
        }
    }

    private async tryInspectImage(identifier: string): Promise<ImageInspectResult | undefined> {
        const res = await run(
            [
                ...settings.getEngineCmd(),
                "image",
                "inspect",
                identifier,
                ...jsonFormat,
            ], this.workspaceFolder, {},
        );

        if (res.exit !== 0) {
            return undefined;
        }
        else {
            return fixDockerImageInspect(res.stdout.trim());
        }
    }

    public async tryContainerInspect(identifier: string): Promise<ContainerInspectResult | undefined> {
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
        const checkExists = await this.tryContainerInspect(this.getContainerName());
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
                throw new InstallError(`Could not query token in container [stdout:${token.stdout.trim()}] [stderr:${token.stderr.trim()}]`);
            }
            return token.stdout.trim();
        }
        else {
            throw new Error(`Container ${this.getContainerName()} does not exist or is not running: (state: ${JSON.stringify(checkExists?.State)})`);
        }
    }

    private async runCreate(imageName: string): Promise<string> {
        // TODO: auto-assign free port and query
        const createRes = await run(
            [
                ...settings.getEngineCmd(),
                ...this.cc.getRunCreateCmd(
                    imageName,
                    this.getContainerName(),
                    ["-p", `${DEVCONTAINER_SERVER_LISTEN_PORT}`],
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
            getLogSink().info(`Started container ${this.getContainerName()} from image ${imageName}`);
        }

        return createRes.stdout.trim();
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

    public getImageHash(name: string) {
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

    private async buildUserImage(): Promise<string> {
        if (!this.cc.isDockerfileBased()) { throw new Error("Expected dockerfile-based config"); }

        const ret = await run([
            ...settings.getEngineCmd(),
            ...this.cc.getBuildCmd({ noCache: this.buildOpts === BuildOpts.RebuildNoCache }),
        ], this.workspaceFolder, {});

        if (ret.exit !== 0) {
            throw new EngineError(`Could not build stage1 image ${formatCmdErr(ret)}`);
        }
        else {
            const output = ret.stdout.trim();

            // expect image name to be in the generated name output
            if (!output.includes(this.cc.getImageName())) {
                throw new Error(`Expected image name to be in build tag output. This is a bug. Tag: '${output}' vs ${this.cc.getImageName()}`);
            }
            return this.cc.getImageName();
        }
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
            await this.startContainer();
            if (!await this.isRunning()) {
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
            downloadTemplateUrl: prodJson.serverUrlTemplate,
            codiumVersion: prodJson.version,
            connectionToken: token,
            forceReinstall: forceReinstall,
        };

        const scriptData = await server.generateInstallScript(info, true);
        const installScriptPath = path.join(this.tempDir, "installScript.sh");
        writeFileSync(installScriptPath, scriptData, { encoding: "utf-8" });

        const destFile = "/tmp/codium-devcontainer-installScript.sh";

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
            const err = getInstallError(installExecResult.stdout.trim());
            throw new InstallError(`Install script at ${this.getContainerName()}:${destFile} failed with code ${installExecResult.exit}: Error: ${err}`);
        }

        const hostPort = await this.getHostmappedPort();

        return { host: "127.0.0.1", port: Number(hostPort), result: installExecResult };
    }

    private async getHostmappedPort() {
        const portCmdRes = await run([
            ...settings.getEngineCmd(),
            "port",
            this.getContainerName(),
            `${DEVCONTAINER_SERVER_LISTEN_PORT}`,
        ], this.workspaceFolder, {});

        if (portCmdRes.exit !== 0) {
            throw new EngineError(`Failed to query host port: ${formatCmdErr(portCmdRes)}`);
        }
        else {
            const allParts = portCmdRes.stdout.trim().split(":");
            const port = allParts.at(-1);
            if (port === undefined) {
                throw new Error(`Could not extract port from '${portCmdRes.stdout}'. This is a bug.`);
            }
            else {
                return port;
            }
        }
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

function fixDockerImageInspect(json: string): ImageInspectResult {
    interface DockerImageInspectResult {
        Config: {
            User: string,
        },
    }

    const data = JSON.parse(json.trim()) as unknown;
    const parsed = data as ImageInspectResult;
    if (getContainerEngine() === "docker") {
        parsed.User = (data as DockerImageInspectResult).Config.User;
    }
    return parsed;
}
