import path from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";

import { runCmd } from "../../common/cmd";
import { ContainerConfig } from "../container";
import { HostUserInfo } from "../../common/utils";
import * as schema from "../../parser/schema";

import { initMocks, ENGINE } from "../../tests/common";

initMocks();

const BASE_IMAGE = "ubuntu:24.04";

function testWsf(label: string) {
    const wsf = path.join(tmpdir(), `stage2-${label}`);
    return { localWsf: wsf, cfgPath: path.join(wsf, ".devcontainer.json") };
}

function imgCfg(overrides: Partial<schema.ImageDevcontainer> = {}): schema.ImageDevcontainer {
    return schema.ConfigSchemaBase.parse({ image: BASE_IMAGE, ...overrides }) as schema.ImageDevcontainer;
}

describe.skipIf(!ENGINE)("stage2 UID remapping", () => {
    if (!ENGINE) { throw new Error("Expected engine to be defined. Did you forget to skip-if a test?"); }
    const engine = ENGINE;

    const images: string[] = [];

    function trackImage(cc: ContainerConfig) {
        images.push(cc.getStage2ImageName());
    }

    async function buildStage2(cc: ContainerConfig, hostInfo: HostUserInfo, imgUser?: string) {
        trackImage(cc);
        const buildCmd = cc.getStage2BuildCmd(hostInfo, imgUser);

        // set context and cwd to a dir that exists
        buildCmd[buildCmd.length - 1] = __dirname;
        return await runCmd(engine, buildCmd, __dirname, {});
    }

    async function runInImage(cc: ContainerConfig, cmd: string[]) {
        return await runCmd(engine, ["run", "--rm", cc.getStage2ImageName(), ...cmd], __dirname, {});
    }

    async function getRemoteUserInfo(cc: ContainerConfig, username: string) {
        const uid = await runInImage(cc, ["id", "-u", username]);
        const gid = await runInImage(cc, ["id", "-g", username]);

        expect(uid.exit).eq(0, "Could not query uid");
        expect(gid.exit).eq(0, "Could not query gid");

        return {
            uid: uid.stdout.trim(),
            gid: gid.stdout.trim(),
        };
    }

    afterAll(async () => {
        for (const img of images) {
            await runCmd(engine, ["rmi", "-f", img], __dirname, {});
        }
    });

    test("root user skips remapping", async () => {
        const { localWsf, cfgPath } = testWsf("root-skip");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg(), {});
        const build = await buildStage2(cc, { uid: 0, gid: 0, name: "root" });
        expect(build.exit).eq(0);
        expect(build.stderr).includes("WARNING: Using user root");
    }, 30_000);

    test("remaps existing user UID/GID to host values", async () => {
        const { localWsf, cfgPath } = testWsf("remap-basic");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "ubuntu" }), {});
        const build = await buildStage2(cc, { uid: 5000, gid: 5000, name: "host" });
        expect(build.exit).eq(0);

        const { uid, gid } = await getRemoteUserInfo(cc, "ubuntu");
        expect(uid).eq("5000");
        expect(gid).eq("5000");
    }, 30_000);

    test("remaps UID when host GID already exists in container", async () => {
        // Regression test for upstream bugs:
        // https://github.com/microsoft/vscode-remote-release/issues/7284
        // https://github.com/devcontainers/cli/issues/494
        // GID 100 ("users" group) exists in ubuntu:24.04. UID must still be remapped.
        const { localWsf, cfgPath } = testWsf("gid-exists");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "ubuntu" }), {});
        const build = await buildStage2(cc, { uid: 2345, gid: 100, name: "host" });
        expect(build.exit).eq(0);

        const { uid, gid } = await getRemoteUserInfo(cc, "ubuntu");
        expect(uid).eq("2345");
        expect(gid).eq("100");
    }, 30_000);

    test("UPDATE_REMOTE_UID=false skips remapping", async () => {
        const { localWsf, cfgPath } = testWsf("skip-remap");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "ubuntu", updateRemoteUserUID: false }), {});
        const build = await buildStage2(cc, { uid: 9999, gid: 9999, name: "host" });
        expect(build.exit).eq(0);
        expect(build.stdout).includes("UPDATE_REMOTE_UID was false");

        const { uid } = await getRemoteUserInfo(cc, "ubuntu");
        expect(uid).not.eq("9999");
    }, 30_000);

    test("nonexistent user fails with descriptive error", async () => {
        const { localWsf, cfgPath } = testWsf("no-user");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "doesnotexist" }), {});

        const build = await buildStage2(cc, { uid: 1000, gid: 1000, name: "host" });
        expect(build.exit).not.eq(0);
        expect(build.stderr).includes("does not exist in container");
    }, 30_000);

    test("UID conflict: moves colliding user before remapping", async () => {
        const { localWsf, cfgPath } = testWsf("uid-conflict");
        const baseTag = "stage2-test-conflict-base:latest";
        images.push(baseTag);

        // Build an intermediate image with a second user (foobar uid=2000).
        // Then remap foobar to uid=1000, which collides with "ubuntu".
        const tmpDockerfile = path.join(tmpdir(), "stage2-test-conflict.Dockerfile");
        writeFileSync(tmpDockerfile, `FROM ${BASE_IMAGE}\nRUN useradd -m -u 2000 foobar\n`);

        const setupBase = await runCmd(engine, [
            "build", "-t", baseTag, "-f", tmpDockerfile, ".",
        ], __dirname, {});
        unlinkSync(tmpDockerfile);
        expect(setupBase.exit).eq(0);

        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ image: baseTag, remoteUser: "foobar" }), {});
        const build = await buildStage2(cc, { uid: 1000, gid: 1000, name: "host" });
        expect(build.exit).eq(0);
        expect(build.stdout.trim()).includes("User 'foobar' exists, updating UID from 2000 to 1000");
        expect(build.stdout.trim()).includes("User 'ubuntu' with ID 1000 already exists. Moving to 2234");

        const { uid } = await getRemoteUserInfo(cc, "foobar");
        expect(uid).eq("1000");

        // original owner of uid 1000 moved to 1000+1234
        const { uid: movedUid } = await getRemoteUserInfo(cc, "ubuntu");
        expect(movedUid).eq("2234");
    }, 30_000);
});
