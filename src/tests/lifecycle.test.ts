import path from "node:path";
import { Uri, window, workspace } from "vscode";
import { afterAll, describe, expect, test, vi } from "vitest";
import { setTimeout } from "node:timers/promises";

import { run, runCmd } from "../common/cmd";
import { initLog } from "../extension/log";
import { ContainerState } from "../engine/lifecycle";
import { ServerInfo } from "../remote/installServer";
import { ContainerConfig } from "../engine/container";
import { parseDevcontainerFile } from "../parser/parser";
import * as server from "../remote/installServer";

import { isImageBased } from "../parser/schema";
import { InstallError } from "../extension/error";
import { parseEnv } from "../common/utils";

function getEngine() {
    return "podman";
}

function getcwd() {
    return __dirname;
}

const jsonFormat = ["--format", "{{json .}}"];

const TEST_CODIUM_INFO: ServerInfo = {
    version: "1.121.03429",
    commit: "824c4c46a288b839f13b24022655329c2aeb9f81",
    serverUrlTemplate: "https://github.com/VSCodium/vscodium/releases/download/1.121.03429/vscodium-reh-${os}-${arch}-1.121.03429.tar.gz",
};

const init = () => {
    const spyCreateOutput = vi.spyOn(window, "createOutputChannel");
    spyCreateOutput.mockReturnValue({
        // info: console.log,
        // warn: console.log,
        // error: console.log,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as any);

    const spySettings = vi.spyOn(workspace, "getConfiguration");
    spySettings.mockReturnValue({
        get: (key: string) => {
            const config: Record<string, string | undefined> = {
                engine: "podman",
            };
            return config[key];
        },
    } as any);

    const spyProdsJson = vi.spyOn(server, "getProductJson");
    spyProdsJson.mockResolvedValue(TEST_CODIUM_INFO);

    initLog("Remote - Devcontainer (tests)");
};

init();

function setupFixture(opts: { name: string, subDir: string }) {
    const fixtureDir = path.join(getcwd(), "fixtures", opts.subDir);

    const containerName: string = ContainerState.getContainerName(fixtureDir);

    afterAll(async () => {
        console.log(`Stopping and removing container ${containerName}`);
        const proc1 = await runCmd(getEngine(), ["container", "stop", containerName], fixtureDir, {});
        const proc2 = await runCmd(getEngine(), ["container", "rm", containerName], fixtureDir, {});

        if (proc1.exit !== 0) { console.log("Warning: Containers were not stopped cleanly. Maybe a bug?"); }
        if (proc2.exit !== 0) { console.log("Warning: Containers were not removed cleanly. Maybe a bug?"); }

        if (proc1.exit !== 0 || proc2.exit !== 0) { await runCmd(getEngine(), ["container", "rm", "--force", containerName], fixtureDir, {}); }
    });

    return { fixtureDir };
}

describe("integration: lifecycle: img-basic", () => {
    let cc: ContainerConfig;
    let container: ContainerState;

    const { fixtureDir } = setupFixture({ name: "image-basic", subDir: "img-basic" });

    const localWsp = fixtureDir;
    const localWspBase = path.parse(fixtureDir).base;
    const localEnv = {
        ...process.env,
        CUSTOM_LOCAL_ENV: "CUSTOM_LOCAL_VAR",
        LOCAL_ENV1: "LOCAL_VAL1",
    };

    test("create", async () => {
        // TODO: use auto-detection
        const devcPath = path.join(localWsp, "devcontainer.json");
        const cfg = parseDevcontainerFile(devcPath);

        cc = ContainerConfig.create(localWsp, cfg, localEnv);

        container = await ContainerState.create(localWsp, cc);
    });

    test("env probe / interpolation", async () => {
        const remoteWsp = cc.getRemoteMountDir();

        const containerEnvs = await container.getContainerEnv();
        expect("PATH" in containerEnvs).toBe(true);

        expect(containerEnvs.LOCAL_WSF).eq(localWsp);
        expect(containerEnvs.REMOTE_WSF).eq(remoteWsp);
        expect(containerEnvs.CONTAINER_ENV1).eq("CONTAINER_VAL1");
        expect(containerEnvs.CONTAINER_ENV2).eq("CONTAINER_VAL2");

        // remoteEnv is injected with exec per-call
        const remoteEnvsOut = await container.engineExec(["bash", "-c", "env -0"]);
        expect(remoteEnvsOut.exit).eq(0);

        const remoteEnvs = parseEnv(remoteEnvsOut.stdout);

        expect(localEnv.LOCAL_ENV1).eq("LOCAL_VAL1");

        expect(remoteEnvs.LOCAL_WSF).eq(localWsp);
        expect(remoteEnvs.REMOTE_WSF).eq(remoteWsp);
        expect(remoteEnvs.CONTAINER_ENV1).eq("CONTAINER_VAL1");
        expect(remoteEnvs.CONTAINER_ENV2).eq("CONTAINER_VAL2");
        expect(remoteEnvs.INTERPOLATE_ALL).eq(`${remoteEnvs.CONTAINER_ENV1}:${localEnv.LOCAL_ENV1}`);

        expect(remoteEnvs.WITH_DEFAULT).eq("fallback");
        expect(remoteEnvs.LOCAL_DEFAULT).eq("/usr/bin:/opt");
        expect(remoteEnvs.APPEND_PATH).eq(`${containerEnvs.PATH}:/extra/bin`);
        expect(remoteEnvs.EMPTY_DEFAULT).eq("");
        expect(remoteEnvs.WORKSPACE_MIX).eq(`${fixtureDir}:${containerEnvs.CONTAINER_ENV2}`);
    });

    test("getResolvedRemoteEnv uses injected custom local env at create time", async () => {
        const containerEnvs = await container.getContainerEnv();
        expect("CUSTOM_LOCAL_ENV" in containerEnvs).toBe(false);
        expect("CUSTOM_LOCAL_ENV_CHECK" in containerEnvs).toBe(false);

        const remoteEnvs = container.getConfig().getResolvedRemoteEnv(containerEnvs);
        expect(remoteEnvs.CUSTOM_LOCAL_ENV_CHECK).toBe("CUSTOM_LOCAL_VAR");
    });

    test("install script and health-check", async () => {
        const { port, result } = await container.installServer();
        expect(result.exit).eq(0);

        const token = await container.getConnectionToken();

        // UUID4
        expect(token.length).eq(36);
        expect(token.split("-").length).eq(5); // 5 items from 4 '-'

        let healthVersion: string | undefined;

        await (async () => {
            for (let retry = 0; retry < 5; ++retry) {
                try {
                    const res = await fetch(`http://127.0.0.1:${port}/version`);
                    if (res.ok) {
                        healthVersion = await res.text();
                        break;
                    }
                    else {
                        console.log(`res.ok: ${res.ok}: ${JSON.stringify(res)}`);
                    }
                }
                catch (e) {
                    console.log(`caught: ${JSON.stringify(e)}`);
                }

                await setTimeout(1000);
            }
        })();

        expect(healthVersion).eq(TEST_CODIUM_INFO.commit);
    }, 60 * 1000);

    test("connection token is stable across calls", async () => {
        const token1 = await container.getConnectionToken();
        const token2 = await container.getConnectionToken();
        expect(token1).eq(token2);
        expect(token1.length).eq(36);
    });

    test("containerExists finds running container", async () => {
        const info = await container.containerExists(container.getContainerName());
        expect(info).toBeDefined();
        expect((info as any).Id).eq(await container.getContainerId());
    });

    test("containerExists returns undefined for nonexistent", async () => {
        const info = await container.containerExists("does-not-exist-xyz-12345");
        expect(info).not.toBeDefined();
    });

    test("container name is deterministic", () => {
        expect(container.getContainerName()).eq(container.getContainerName());
    });

    test("getContainerEnv is stable across calls", async () => {
        const env1 = await container.getContainerEnv();
        const env2 = await container.getContainerEnv();
        expect(env1.PATH).eq(env2.PATH);
        expect(env1.CONTAINER_ENV1).eq(env2.CONTAINER_ENV1);
    });
});

describe("integration: lifecycle: img-basic", () => {
    let cc: ContainerConfig;
    let container: ContainerState;

    const { fixtureDir } = setupFixture({ name: "image-pull", subDir: "img-pull" });

    const localWsf = fixtureDir;
    const localWspBase = path.parse(fixtureDir).base;
    const localEnv = {
        ...process.env,
        CUSTOM_LOCAL_ENV: "CUSTOM_LOCAL_VAR",
        LOCAL_ENV1: "LOCAL_VAL1",
    };

    const devcPath = path.join(localWsf, "devcontainer.json");
    const cfg = parseDevcontainerFile(devcPath);

    if (!isImageBased(cfg)) {
        expect(isImageBased(cfg)).toBe(true);
        throw new Error("Expeced image-based config");
    }

    const imageName = cfg.image;

    test("pull image and create container with missing local image", async () => {
        expect(imageName).toBe("ubuntu:22.04");

        // remove image first, if exists
        await run([getEngine(), "image", "rm", imageName], localWsf, localEnv);

        const inspectResult = await run([getEngine(), "inspect", imageName, ...jsonFormat], localWsf, localEnv);
        expect(inspectResult.exit).not.eq(0);
        expect(inspectResult.stdout).toBe("");

        cc = ContainerConfig.create(localWsf, cfg, localEnv);
        container = await ContainerState.create(localWsf, cc);
        const cId = await container.getContainerId();

        expect(cId.length).toBeGreaterThan(16);
    });

    test("getConnectionToken returns correct token over multiple install (without force)", async () => {
        const firstInstall = await container.installServer();
        const token = await container.getConnectionToken();

        for (let i = 0; i < 3; ++i) {
            const installServer = await container.installServer();

            console.log(installServer);

            const catResult = await run([
                getEngine(),
                "exec",
                await container.getContainerId(),
                "bash",
                "-c",
                "cat ${HOME}/.vscode-oss-devcontainer/token",
            ], localWsf, localEnv);

            expect(catResult.exit).eq(0);
            expect(catResult.stdout.trim()).eq(token);

            const iterTok = await container.getConnectionToken();
            expect(iterTok).eq(token);
        }

        const stopResult = await container.stopContainer();
        expect(stopResult).eq(container.getContainerName());

        for (let i = 0; i < 3; ++i) {
            const installServer = await container.installServer();

            console.log(installServer);

            const catResult = await run([
                getEngine(),
                "exec",
                await container.getContainerId(),
                "bash",
                "-c",
                "cat ${HOME}/.vscode-oss-devcontainer/token",
            ], localWsf, localEnv);

            expect(catResult.exit).eq(0);
            expect(catResult.stdout.trim()).eq(token);

            const iterTok = await container.getConnectionToken();
            expect(iterTok).eq(token);
        }
    }, 60 * 1000);

    test("getConnectionToken dies on stopped container", async () => {
        const installServer = await container.installServer();
        console.log(installServer);

        await container.stopContainer();
        await expect(container.getConnectionToken()).rejects.toThrow(Error);
    }, 60 * 1000);
});
