import path from "node:path";
import { describe, expect, test } from "vitest";

import { run } from "../../../common/cmd";
import { ContainerState } from "../../../engine/lifecycle";
import { ContainerConfig } from "../../../engine/container";
import * as schema from "../../../parser/schema";

import { init, setupFixture, jsonFormat, ENGINE } from "../../common";

if (ENGINE) { init(); }

describe.skipIf(!ENGINE)("integration: lifecycle: img-pull", () => {
    const engine = ENGINE!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

    let cc: ContainerConfig;
    let container: ContainerState;

    const { localWsf, config } = setupFixture({ name: "image-pull", testDir: __dirname });
    const devcPath = path.join(localWsf, ".devcontainer/devcontainer.json");

    const localEnv = {
        ...process.env,
        CUSTOM_LOCAL_ENV: "CUSTOM_LOCAL_VAR",
        LOCAL_ENV1: "LOCAL_VAL1",
    };

    let imageName: string;

    test("create config", () => {
        if (!schema.isImageBased(config)) {
            expect(schema.isImageBased(config)).toBe(true);
            throw new Error("Expected image-based config");
        }
        imageName = config.image;

        expect(imageName).toBe("ubuntu:22.04");
    });

    test("pull image and create container with missing local image", async () => {
        // remove image first, if exists
        await run([engine, "image", "rm", imageName], localWsf, localEnv);

        const inspectResult = await run([engine, "inspect", imageName, ...jsonFormat], localWsf, localEnv);
        expect(inspectResult.exit).not.eq(0);
        expect(inspectResult.stdout.trim()).toBe("");

        cc = ContainerConfig.create(localWsf, devcPath, config, localEnv);
        container = await ContainerState.create(localWsf, cc);
        const cId = await container.getContainerId();

        expect(cId.length).toBeGreaterThan(16);
    }, 30_000);

    test("getConnectionToken returns correct token over multiple install (without force)", async () => {
        const firstInstall = await container.installServer();
        expect(firstInstall.result.exit).eq(0);
        const token = await container.getConnectionToken();

        for (let i = 0; i < 3; ++i) {
            const installServer = await container.installServer();
            expect(installServer.result.exit).eq(0);

            const catResult = await run([
                engine,
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
            expect(installServer.result.exit).eq(0);

            const catResult = await run([
                engine,
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
    }, 60_0000);

    test("getConnectionToken dies on stopped container", async () => {
        const installServer = await container.installServer();
        expect(installServer.result.exit).eq(0);

        await container.stopContainer();
        await expect(container.getConnectionToken()).rejects.toThrow(Error);
    }, 60_0000);
});
