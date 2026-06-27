import { describe, expect, test } from "vitest";
import { setTimeout } from "node:timers/promises";

import { ContainerState } from "../../../engine/lifecycle";
import { ContainerConfig } from "../../../engine/container";
import { parseEnv } from "../../../common/utils";

import { init, setupFixture, jsonFormat, TEST_CODIUM_INFO, ENGINE } from "../../common";
import { run } from "../../../common/cmd";

init();

describe.skipIf(!ENGINE)("integration: lifecycle: img-basic", () => {
    let cc: ContainerConfig;
    let container: ContainerState;

    const { localWsf, localWsfBasename, config } = setupFixture({ name: "image-basic", testDir: __dirname });

    const localEnv = {
        ...process.env,
        CUSTOM_LOCAL_ENV: "CUSTOM_LOCAL_VAR",
        LOCAL_ENV1: "LOCAL_VAL1",
    };

    test("create", async () => {
        // TODO: use auto-detection
        cc = ContainerConfig.create(localWsf, config, localEnv);

        container = await ContainerState.create(localWsf, cc);
    }, 60 * 1000);

    test("workspace mounts exists", async () => {
        const inspectResult = await run([ENGINE!, "inspect", container.getContainerName(), ...jsonFormat], localWsf, localEnv);
        expect(inspectResult.exit).eq(0);

        const mounts = JSON.parse(inspectResult.stdout.trim())["Mounts"];

        const mountsFound: number = (() => {
            let found = 0;
            for (const mount of mounts) {
                const [source, dest, rw] = [mount["Source"], mount["Destination"], mount["RW"]];
                found += (source == localWsf && dest === "/workdir1") ? 1 : 0;
                found += (source == localWsf && dest === "/workdir2" && rw === false) ? 1 : 0;
            }
            return found;
        })();

        expect(mountsFound).eq(2);
    });

    test("env probe / interpolation", async () => {
        const remoteWsp = cc.getRemoteMountDir();

        const containerEnvs = await container.getContainerEnv();
        expect("PATH" in containerEnvs).toBe(true);

        expect(containerEnvs.LOCAL_WSF).eq(localWsf);
        expect(containerEnvs.REMOTE_WSF).eq(remoteWsp);
        expect(containerEnvs.CONTAINER_ENV1).eq("CONTAINER_VAL1");
        expect(containerEnvs.CONTAINER_ENV2).eq("CONTAINER_VAL2");

        // remoteEnv is injected with exec per-call
        const remoteEnvsOut = await container.engineExec(["bash", "-c", "env -0"]);
        expect(remoteEnvsOut.exit).eq(0);

        const remoteEnvs = parseEnv(remoteEnvsOut.stdout);

        expect(localEnv.LOCAL_ENV1).eq("LOCAL_VAL1");

        expect(remoteEnvs.LOCAL_WSF).eq(localWsf);
        expect(remoteEnvs.REMOTE_WSF).eq(remoteWsp);
        expect(remoteEnvs.CONTAINER_ENV1).eq("CONTAINER_VAL1");
        expect(remoteEnvs.CONTAINER_ENV2).eq("CONTAINER_VAL2");
        expect(remoteEnvs.INTERPOLATE_ALL).eq(`${remoteEnvs.CONTAINER_ENV1}:${localEnv.LOCAL_ENV1}`);

        expect(remoteEnvs.WITH_DEFAULT).eq("fallback");
        expect(remoteEnvs.LOCAL_DEFAULT).eq("/usr/bin:/opt");
        expect(remoteEnvs.APPEND_PATH).eq(`${containerEnvs.PATH}:/extra/bin`);
        expect(remoteEnvs.EMPTY_DEFAULT).eq("");
        expect(remoteEnvs.WORKSPACE_MIX).eq(`${localWsf}:${containerEnvs.CONTAINER_ENV2}`);
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
        const info = await container.tryContainerInspect(container.getContainerName());
        expect(info).toBeDefined();
        expect(info!.Id).eq(await container.getContainerId());
    });

    test("containerExists returns undefined for nonexistent", async () => {
        const info = await container.tryContainerInspect("does-not-exist-xyz-12345");
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
