import path from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";

import { run } from "../../common/cmd";
import { ContainerConfig, ContainerEngine } from "../container";
import { HostUserInfo } from "../../common/utils";
import * as schema from "../../parser/schema";
import * as lf from "../lifecycle";

import { getMockSettings, initMocks } from "../../tests/common";
import { CAT_PIPE_STDIN_WORKAROUND } from "../../common/constants";

function testWsf(label: string) {
    const wsf = path.join(tmpdir(), `stage2-${label}`);
    mkdirSync(wsf, { recursive: true });
    return { localWsf: wsf, cfgPath: path.join(wsf, ".devcontainer.json") };
}

function imgCfg(overrides: Partial<schema.ImageDevcontainer> = {}): schema.ImageDevcontainer {
    return schema.ConfigSchemaBase.parse({ image: BASE_IMAGE, ...overrides }) as schema.ImageDevcontainer;
}

const BASE_IMAGE = "ubuntu:24.04";

const SETTINGS = getMockSettings();
initMocks();

describe.skipIf(!SETTINGS.dockerPath)("stage2 UID remapping", () => {
    const engine = SETTINGS.dockerPath;

    const images: string[] = [];

    function trackImage(cc: ContainerConfig) {
        images.push(cc.getStage2ImageName());
    }

    async function buildStage2(cc: ContainerConfig, hostInfo: HostUserInfo, imgUser?: string) {
        trackImage(cc);
        const dockerfile = await lf.readStage2Dockerfile();
        const buildCmd = cc.getStage2BuildCmd(hostInfo, imgUser, { noCache: true });

        // set context and cwd to a dir that exists
        buildCmd[buildCmd.length - 1] = __dirname;
        return await run([...CAT_PIPE_STDIN_WORKAROUND, engine, ...buildCmd], { cwd: __dirname, stdin: dockerfile });
    }

    async function runInImage(cc: ContainerConfig, cmd: string[]) {
        return await run([engine, "run", "--rm", cc.getStage2ImageName(), ...cmd], { cwd: __dirname });
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
            await run([engine, "rmi", "-f", img], { cwd: __dirname });
        }
    });

    test("root user skips remapping", async () => {
        const { localWsf, cfgPath } = testWsf("root-skip");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg(), {});
        const build = await buildStage2(cc, { uid: 0, gid: 0, name: "root" });
        const output = build.stdout.trim() + build.stderr.trim();
        expect(build.exit).eq(0);
        const warnMsg = Array.from(output.matchAll(lf.STAGE2_WARN_MSG_REGEX));
        expect(warnMsg.length).eq(1);
        expect(warnMsg[0][1]).includes("Using user root");
    }, 45_000);

    test("remaps existing user UID/GID to host values", async () => {
        const { localWsf, cfgPath } = testWsf("remap-basic");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "ubuntu" }), {});
        const build = await buildStage2(cc, { uid: 5000, gid: 5000, name: "host" });
        expect(build.exit).eq(0);

        const { uid, gid } = await getRemoteUserInfo(cc, "ubuntu");
        expect(uid).eq("5000");
        expect(gid).eq("5000");
    }, 45_000);

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
    }, 45_000);

    test("UPDATE_REMOTE_UID=false skips remapping", async () => {
        const { localWsf, cfgPath } = testWsf("skip-remap");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "ubuntu", updateRemoteUserUID: false }), {});
        const build = await buildStage2(cc, { uid: 9999, gid: 9999, name: "host" });
        expect(build.exit).eq(0);
        const output = build.stdout.trim() + build.stderr.trim();
        const infoMsg = Array.from(output.matchAll(lf.STAGE2_INFO_MSG_REGEX));
        expect(infoMsg.length).eq(1);
        expect(infoMsg[0][1]).includes("UPDATE_REMOTE_UID was false");

        const { uid } = await getRemoteUserInfo(cc, "ubuntu");
        expect(uid).not.eq("9999");
    }, 45_000);

    test("nonexistent user fails with descriptive error", async () => {
        const { localWsf, cfgPath } = testWsf("no-user");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "doesnotexist" }), {});

        const build = await buildStage2(cc, { uid: 1000, gid: 1000, name: "host" });
        expect(build.exit).not.eq(0);
        const output = build.stdout.trim() + build.stderr.trim();
        const errMsg = Array.from(output.matchAll(lf.STAGE2_ERR_MSG_REGEX));
        expect(errMsg.length).toBeGreaterThanOrEqual(1);
        expect(errMsg[0][1]).includes("does not exist in container");
    }, 45_000);

    test("UID conflict: moves colliding user before remapping", async () => {
        const { localWsf, cfgPath } = testWsf("uid-conflict");
        const baseTag = "stage2-test-conflict-base:latest";
        images.push(baseTag);

        // Build an intermediate image with a second user (foobar uid=2000).
        // Then remap foobar to uid=1000, which collides with "ubuntu".
        const dockerfile = `FROM ${BASE_IMAGE}\nRUN useradd -m -u 2000 foobar\n`;

        const setupBase = await run([
            ...CAT_PIPE_STDIN_WORKAROUND, engine, "build", "-t", baseTag, "-f", "-", ".",
        ], { cwd: __dirname, stdin: dockerfile });
        expect(setupBase.exit).eq(0);

        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ image: baseTag, remoteUser: "foobar" }), {});
        const build = await buildStage2(cc, { uid: 1000, gid: 1000, name: "host" });
        expect(build.exit).eq(0);
        const output = build.stdout.trim() + build.stderr.trim();
        expect(output).includes("User 'foobar' exists, updating UID from 2000 to 1000");
        expect(output).includes("User 'ubuntu' with ID 1000 already exists. Moving to 2234");

        const { uid } = await getRemoteUserInfo(cc, "foobar");
        expect(uid).eq("1000");

        // original owner of uid 1000 moved to 1000+1234
        const { uid: movedUid } = await getRemoteUserInfo(cc, "ubuntu");
        expect(movedUid).eq("2234");
    }, 45_000);
});

describe.skipIf(SETTINGS.dockerPath !== "podman")("podman: --userns=keep-id", () => {
    const containers: lf.ContainerState[] = [];
    const engine = SETTINGS.dockerPath;

    afterAll(async () => {
        for (const c of containers) {
            await run([engine, "container", "stop", "-t", "2", c.getContainerName()], { cwd: __dirname });
            await run([engine, "container", "rm", "--force", c.getContainerName()], { cwd: __dirname });
            await run([engine, "rmi", "-f", c.getConfig().getStage2ImageName()], { cwd: __dirname });
        }
    });

    test("non-root remoteUser: workspace is readable and writable", async () => {
        const { localWsf, cfgPath } = testWsf("podman-keepid");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "ubuntu" }), {}, { engine: ContainerEngine.podman });

        const container = await lf.ContainerState.create(localWsf, cc, SETTINGS);
        containers.push(container);

        const wsDir = container.getConfig().getRemoteMountDir();

        const read = await container.engineExec(["ls", wsDir]);
        expect(read.exit).eq(0);

        const marker = `podman-keepid-${Date.now()}`;
        const write = await container.engineExec(["touch", `${wsDir}/${marker}`]);
        expect(write.exit).eq(0);

        const cleanup = await container.engineExec(["rm", `${wsDir}/${marker}`]);
        expect(cleanup.exit).eq(0);
    }, 60_000);

    test("non-root remoteUser: uid inside container matches host uid", async () => {
        const { localWsf, cfgPath } = testWsf("podman-keepid-uid");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg({ remoteUser: "ubuntu" }), {}, { engine: ContainerEngine.podman });

        const container = await lf.ContainerState.create(localWsf, cc, SETTINGS);
        containers.push(container);

        const res = await container.engineExec(["id", "-u"]);
        expect(res.exit).eq(0);
        expect(res.stdout.trim()).eq(String(process.getuid?.()));
    }, 60_000);

    test("root remoteUser: no keep-id, workspace still accessible", async () => {
        const { localWsf, cfgPath } = testWsf("podman-root");
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg(), {}, { engine: ContainerEngine.podman });

        const container = await lf.ContainerState.create(localWsf, cc, SETTINGS);
        containers.push(container);

        const wsDir = container.getConfig().getRemoteMountDir();

        const read = await container.engineExec(["ls", wsDir]);
        expect(read.exit).eq(0);

        const write = await container.engineExec(["touch", `${wsDir}/podman-root-test`]);
        expect(write.exit).eq(0);

        const cleanup = await container.engineExec(["rm", `${wsDir}/podman-root-test`]);
        expect(cleanup.exit).eq(0);
    }, 60_000);
});
