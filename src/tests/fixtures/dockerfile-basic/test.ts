import path from "node:path";
import assert from "node:assert";
import { describe, expect, test } from "vitest";

import { ContainerState } from "../../../engine/lifecycle";
import { ContainerConfig } from "../../../engine/container";
import { getHostUserInfo, parseEnv } from "../../../common/utils";

import { initMocks, setupFixture, getMockSettings } from "../../common";

interface LifecycleEntry {
    cmd: string,
    ts: number,
}

function parseLifecycleLog(stdout: string): LifecycleEntry[] {
    return stdout.trim().split("\n").map(line => JSON.parse(line) as LifecycleEntry);
}

const SETTINGS = getMockSettings();
initMocks();

describe.skipIf(!SETTINGS.dockerPath)("integration: dockerfile-basic", async () => {
    let cc: ContainerConfig;
    let container: ContainerState;

    const { localWsf, config } = await setupFixture({ name: "dockerfile-basic", testDir: __dirname });
    const devcPath = path.join(localWsf, ".devcontainer/devcontainer.json");

    const localEnv = {
        ...process.env,
        TEST_LOCAL_VAR: "from-host",
    };

    test("create", async () => {
        cc = ContainerConfig.create(localWsf, devcPath, config, localEnv);
        expect(cc.isDockerfileBased()).toBe(true);
        expect(cc.isImageBased()).toBe(false);
        container = await ContainerState.create(localWsf, cc, SETTINGS);
    }, 60_000);

    test("build arg was passed", async () => {
        const res = await container.engineExec(["cat", "/tmp/build-arg-check"]);
        expect(res.exit).eq(0);
        expect(res.stdout.trim()).eq("hello-from-build");
    });

    test("stage2 remapped UID to match host", async () => {
        const hostInfo = await getHostUserInfo();
        const res = await container.engineExec(["id", "-u", "ubuntu"]);
        expect(res.exit).eq(0);
        expect(res.stdout.trim()).eq(String(hostInfo.uid));
    });

    test("build context resolved to project root", async () => {
        const res = await container.engineExec(["cat", "/tmp/context-marker.txt"]);
        expect(res.exit).eq(0);
        expect(res.stdout.trim()).eq("context-resolution-works");
    });

    test("env interpolation across containerEnv, remoteEnv, localEnv", async () => {
        const containerEnvs = await container.getContainerEnv();
        expect(containerEnvs.LOCAL_WSF).eq(localWsf);
        expect(containerEnvs.CENV_STATIC).eq("static-val");

        const remoteWsf = cc.getRemoteMountDir();
        const remoteOut = await container.engineExec(["bash", "-c", "env -0"]);
        expect(remoteOut.exit).eq(0);
        const remoteEnvs = parseEnv(remoteOut.stdout);

        expect(remoteEnvs.RENV_MIX).eq(`static-val:from-host:${remoteWsf}`);
    });

    test("lifecycle commands ran in order", async () => {
        const res = await container.engineExec(["cat", "/tmp/lifecycle.log"]);
        expect(res.exit).eq(0);

        const entries = parseLifecycleLog(res.stdout);
        expect(entries).toHaveLength(4);

        const expectedOrder = ["onCreate-deps", "updateContent", "postCreate", "postStart"];
        expect(entries.map(e => e.cmd)).toStrictEqual(expectedOrder);

        for (let i = 1; i < entries.length; i++) {
            expect(entries[i].ts, `${entries[i].cmd} should be >= ${entries[i - 1].cmd}`)
                .toBeGreaterThanOrEqual(entries[i - 1].ts);
        }

        expect(entries.some(e => e.cmd === "postAttach")).toBe(false);
    });

    test("record-style lifecycle entries ran in parallel", async () => {
        const mainRes = await container.engineExec(["cat", "/tmp/lifecycle.log"]);
        expect(mainRes.exit).eq(0);
        const depsEntry = parseLifecycleLog(mainRes.stdout).find(e => e.cmd === "onCreate-deps");
        expect(depsEntry).toBeDefined();

        assert.ok(depsEntry);
        const setupRes = await container.engineExec(["cat", "/tmp/onCreate-setup.log"]);
        expect(setupRes.exit).eq(0);
        const setupEntry = JSON.parse(setupRes.stdout.trim()) as LifecycleEntry;
        expect(setupEntry.cmd).eq("onCreate-setup");

        const diffMs = Math.abs(depsEntry.ts - setupEntry.ts) / 1_000_000;
        expect(diffMs, "record entries should start within 100ms of each other").toBeLessThan(100);
    });

    test("postStart runs again on container restart", async () => {
        await container.stopContainer();
        container = await ContainerState.create(localWsf, cc, SETTINGS);

        const res = await container.engineExec(["cat", "/tmp/lifecycle.log"]);
        expect(res.exit).eq(0);

        const entries = parseLifecycleLog(res.stdout);
        expect(entries).toHaveLength(5);

        const lastEntry = entries[4];
        const prevEntry = entries[3];
        expect(lastEntry.cmd).eq("postStart");
        expect(lastEntry.ts).toBeGreaterThan(prevEntry.ts);

        const cmds = entries.map(e => e.cmd);
        expect(cmds.filter(c => c === "onCreate-deps")).toHaveLength(1);
        expect(cmds.filter(c => c === "updateContent")).toHaveLength(1);
        expect(cmds.filter(c => c === "postCreate")).toHaveLength(1);
        expect(cmds.filter(c => c === "postStart")).toHaveLength(2);
    }, 30_000);
});
