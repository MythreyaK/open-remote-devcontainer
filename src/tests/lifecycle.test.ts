import path from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { Uri, window, workspace } from 'vscode';

import { ContainerState } from '../engine/lifecycle';
import { getActiveWorkspace } from '../extension/workspace';
import { initLog } from '../extension/log';
import { spawn } from 'node:child_process';
import { runCmd } from '../common/cmd';
import { parseDevcontainerFile } from '../parser/parser';
import { extractWorkspaceMount } from '../parser/schema';
import { ContainerConfig } from '../engine/container';
import { parseEnv } from '../common/utils';

function getEngine() {
    return "podman";
}

function getcwd() {
    return __dirname;
}


const init = () => {
    const spyCreateOutput = vi.spyOn(window, 'createOutputChannel');
    spyCreateOutput.mockReturnValue({
        // info: console.log,
        // warn: console.log,
        // error: console.log,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as any);

    const spySettings = vi.spyOn(workspace, 'getConfiguration');
    spySettings.mockReturnValue({
        get: (key: string) => {
            const config: Record<string, string | undefined> = {
                "engine": "podman"
            };
            return config[key];
        }
    } as any);

    initLog("Remote - Devcontainer (tests)");
};

init();

describe("integration: lifecycle: img-basic", () => {
    const fixtureDir = path.join(getcwd(), "fixtures", "img-basic");

    (workspace as any).setWorkspaceFolders([
        { uri: Uri.file(fixtureDir), name: 'img-basic', index: 0 },
    ]);

    let containerId: string | undefined;
    const localEnvBackup = { ...process.env };
    process.env.LOCAL_ENV1 = "LOCAL_VAL1";

    const localEnv = process.env;

    afterAll(async () => {
        if (containerId !== undefined) {
            console.log(`Stopping and removing container ${containerId}`);
            const proc1 = await runCmd(getEngine(), ["container", "stop", containerId], {});
            const proc2 = await runCmd(getEngine(), ["container", "rm", containerId], {});

            expect(proc1.exit).eq(0);
            expect(proc2.exit).eq(0);
        }
        else {
            throw new Error("Container ID after test was undefined. Expected a value");
        }
        process.env = localEnvBackup;
    });

    const localWsp = getActiveWorkspace();
    const localWspBase = path.parse(getActiveWorkspace()).base;

    let cc: ContainerConfig;
    let container: ContainerState;

    test("create", async () => {
        // TODO: use auto-detection
        const devcPath = path.join(getActiveWorkspace(), "devcontainer.json");
        const cfg = parseDevcontainerFile(devcPath);

        cc = ContainerConfig.create(getActiveWorkspace(), cfg);

        container = await ContainerState.create(getActiveWorkspace(), devcPath, cc);
        containerId = container.getContainerId();
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
        expect(remoteEnvs.WORKSPACE_MIX).eq(`${getActiveWorkspace()}:${containerEnvs.CONTAINER_ENV2}`);
    });

});
