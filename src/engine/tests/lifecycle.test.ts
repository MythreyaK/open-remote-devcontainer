import path from "node:path";
import { describe, expect, test } from "vitest";

import * as schema from "../../parser/schema";
import { ContainerConfig } from "../container";
import { getLogSink } from "../../extension/log";
import { getHostUserInfo, HostUserInfo } from "../../common/utils";

import { sanityCheck, withDefaults } from "./common";
import { initMocks } from "../../tests/common";
import { getWorkspaceId } from "../../extension/workspace";

initMocks();

const localEnv = {
    APP_PORT: "5040",
    HOME: "/foo/bar",
} as NodeJS.ProcessEnv;

const common = {
    name: "foobar",
    containerUser: "foo",
    appPort: [100, "123:456", "${localEnv:APP_PORT:4040}:${localEnv:FOO_PORT:5012}"],
    mounts: [
        {
            type: "bind",
            source: "${localWorkspaceFolder}",
            target: "${localEnv:HOME:/home/root}/projects/${localWorkspaceFolderBasename}",
        },
        {
            type: "bind",
            source: "/a",
            target: "/b",
        },
        "source=/c,target=/d,type=bind",
    ],
    workspaceMount: "source=${localWorkspaceFolder}/sub-folder,target=/workspace/dir,type=bind,consistency=cached",
    containerEnv: { MY_ENV1: "MY_VAL1=${localEnv:HOME}", HOME: "${localEnv:HOME}" },
    runArgs: ["--device", "/dev/kfd", "--pid", "host"],
    capAdd: ["CAP_BPF", "CAP_CHOWN"],
    securityOpt: ["seccomp=unconfined", "no-new-privileges=true"],
};

let _hostUserInfo: HostUserInfo | undefined;

test("hostUserInfo", async () => {
    _hostUserInfo = await (async () => {
        try {
            return await getHostUserInfo();
        }
        catch (e) {
            getLogSink().error(`Could not query host info! ${JSON.stringify(e)}`);
            return {
                uid: 1000,
                gid: 1000,
                name: "username",
            };
        }
    })();
});

describe("lifecycle: image", () => {
    const localWsf = "/tmp/dir";
    const localWsfBase = path.parse(localWsf).base;
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    const imgCfg = withDefaults({
        ...common,
        image: "ubuntu:24.04",
    });

    test("create cmd: create container cmd", () => {
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg, localEnv);
        expect(cc.isImageBased()).toBe(true);
        expect(cc.isDockerfileBased()).toBe(false);

        if (cc.isImageBased()) {
            const createArgs = cc.getRunCreateCmd(imgCfg.image, "foobar").join(" ");
            expect(createArgs)
                .includes("run -d ")
                .includes("-u foo ")
                .includes("-p 100 -p 123:456 -p 5040:5012 ")
                .includes(`-v ${localWsf}:${localEnv.HOME}/projects/${localWsfBase} `)
                .includes("--mount source=/tmp/dir/sub-folder,target=/workspace/dir,type=bind,consistency=cached ")
                .includes("--env MY_ENV1=MY_VAL1=/foo/bar --env HOME=/foo/bar ")
                .includes("--device /dev/kfd --pid host ")
                .includes("--cap-add CAP_BPF --cap-add CAP_CHOWN ")
                .includes("--security-opt seccomp=unconfined --security-opt no-new-privileges=true ");
        }
    });

    test("create cmd: single (non-array) appPort", () => {
        const cfgStr = withDefaults({ image: "ubuntu", appPort: "8080" });
        const ccStr = ContainerConfig.create(localWsf, cfgPath, cfgStr, {});
        expect(ccStr.getRunCreateCmd("ubuntu", "test").join(" ")).includes("-p 8080");

        const cfgNum = withDefaults({ image: "ubuntu", appPort: 3000 });
        const ccNum = ContainerConfig.create(localWsf, cfgPath, cfgNum, {});
        expect(ccNum.getRunCreateCmd("ubuntu", "test").join(" ")).includes("-p 3000");
    });

    test("create cmd: --privileged and --init flags", () => {
        const cfg = withDefaults({ image: "ubuntu", privileged: true, init: true });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getRunCreateCmd("ubuntu", "test").join(" ");
        expect(args).includes("--privileged");
        expect(args).includes("--init");
    });

    test("run cmd: string mounts use '--mount' flag", () => {
        const cc = ContainerConfig.create(localWsf, cfgPath, imgCfg, localEnv);
        const runArgs = cc.getRunCreateCmd(imgCfg.image, "foobar").join(" ");
        expect(runArgs)
            .includes("run ")
            .includes(" --mount source=/c,target=/d,type=bind ")
            .includes(" -v /a:/b ");
    });
});

describe("lifecycle: dockerfile", () => {
    const localWsf = "/tmp/dir";
    const localWsfBase = path.parse(localWsf).base;
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    const dockerfileCfg = withDefaults({
        ...common,
        build: {
            dockerfile: "dockerfile",
            args: { ARG1: "VAL1", ARG2: "${localWorkspaceFolderBasename}", HOMEDIR: "${localWorkspaceFolder}" },
        },
    });

    test("build image cmd", () => {
        const cc = ContainerConfig.create(localWsf, cfgPath, dockerfileCfg, localEnv);
        expect(cc.isImageBased()).toBe(false);
        expect(cc.isDockerfileBased()).toBe(true);

        if (cc.isDockerfileBased()) {
            const buildArgs = cc.getBuildCmd().join(" ");
            expect(buildArgs)
                .includes("build ")
                .includes(`--build-arg ARG1=VAL1 --build-arg ARG2=${localWsfBase} --build-arg HOMEDIR=${localWsf}`)
                .includes(" -f /tmp/dir/.devcontainer/dockerfile ");

            expect(buildArgs.endsWith(" /tmp/dir/.devcontainer")).toBe(true);

            expect(buildArgs).not.includes("--pull");
            expect(buildArgs).not.includes("--no-cache");
        }
    });

    test("build image cmd (noCache)", () => {
        const localWsf = __dirname;
        const localWsfBase = path.parse(localWsf).base;
        const cfgPath = path.join(localWsf, ".devcontainer.json");
        sanityCheck(localWsf, cfgPath);

        expect(_hostUserInfo).toBeDefined();
        const hostUserInfo = _hostUserInfo!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

        const cc = ContainerConfig.create(localWsf, cfgPath, dockerfileCfg, localEnv);
        expect(cc.isImageBased()).toBe(false);
        expect(cc.isDockerfileBased()).toBe(true);

        if (cc.isDockerfileBased()) {
            const stage1 = cc.getBuildCmd({ noCache: true }).join(" ");
            expect(stage1)
                .includes("build ")
                .includes(`--build-arg ARG1=VAL1 --build-arg ARG2=${localWsfBase} --build-arg HOMEDIR=${localWsf}`)
                .includes(" --pull ")
                .includes(" --no-cache ")
                .includes(`-f ${localWsf}/dockerfile`);

            expect(stage1.endsWith(` ${__dirname}`)).toBe(true);

            const stage2 = cc.getStage2BuildCmd(hostUserInfo, "root", { noCache: true }).join(" ");
            expect(stage2)
                .includes("build ")
                .includes(" --no-cache ");

            // stage2 source is always local
            expect(stage2)
                .not.includes(" --pull ");

            expect(stage2.endsWith(` ${__dirname}`)).toBe(true);
        }
    });

    test("build cmd: --target flag", () => {
        const cfg = withDefaults({
            build: { dockerfile: "Dockerfile", target: "builder" },
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getBuildCmd().join(" ");
        expect(args).includes(" --target builder ");
    });

    test("build cmd: --cache-from single string", () => {
        const cfg = withDefaults({
            build: { dockerfile: "Dockerfile", cacheFrom: "myregistry/myimage:latest" },
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getBuildCmd().join(" ");
        expect(args).includes(" --cache-from myregistry/myimage:latest ");
        expect(args).not.includes("--no-cache");
    });

    test("build cmd: --cache-from array", () => {
        const cfg = withDefaults({
            build: { dockerfile: "Dockerfile", cacheFrom: ["img1:latest", "img2:v1"] },
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getBuildCmd().join(" ");
        expect(args).includes(" --cache-from img1:latest --cache-from img2:v1 ");
    });

    test("build cmd: --cache-from skipped when noCache", () => {
        const cfg = withDefaults({
            build: { dockerfile: "Dockerfile", cacheFrom: "myregistry/myimage:latest" },
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getBuildCmd({ noCache: true }).join(" ");
        expect(args).includes(" --no-cache ");
        expect(args).includes(" --pull ");
        expect(args).not.includes("--cache-from");
    });

    test("build cmd: no --cache-from when not specified", () => {
        const cfg = withDefaults({
            build: { dockerfile: "Dockerfile" },
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getBuildCmd().join(" ");
        expect(args).not.includes("--cache-from");
    });

    describe("context", () => {
        test("build: implicit context dir", () => {
            const cc = ContainerConfig.create(localWsf, cfgPath, dockerfileCfg, localEnv);
            expect(cc.getResolvedBuildcontextDir()).toBe("/tmp/dir/.devcontainer");
            expect(cc.getResolvedDockerfilePath()).toBe("/tmp/dir/.devcontainer/dockerfile");
        });

        test("build: explicit context dir", () => {
            const newCfg: schema.DockerfileDevcontainer = {
                ...dockerfileCfg,
                build: {
                    ...dockerfileCfg.build,
                    context: "..",
                },
            };

            const cc = ContainerConfig.create(localWsf, cfgPath, newCfg, localEnv);
            expect(cc.getResolvedBuildcontextDir()).toBe("/tmp/dir");
            expect(cc.getResolvedDockerfilePath()).toBe("/tmp/dir/.devcontainer/dockerfile");
        });

        test("build: explicit context and dockerfile dir", () => {
            const newCfg = withDefaults({
                ...dockerfileCfg,
                build: {
                    dockerfile: "../Dockerfile",
                    context: "..",
                },
                remoteEnv: {
                    Local1Env: "null",
                    LOCALENV2: "HELLO",
                    LOCALENV3: "undefined",
                    Local2Env: null,
                    LOCALENV4: "HELLO",
                    LOCALENV5: null,
                },
            });

            const cc = ContainerConfig.create(localWsf, cfgPath, newCfg, localEnv);
            const execCmd = cc.getExecArgs(cc.getConfigId(), {}).join(" ");
            expect(execCmd).includes(`${cc.getConfigId()} env -u Local2Env -u LOCALENV5`);
        });
    });
});

describe("lifecycle", () => {
    const localWsf = "/tmp/dir";
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    test("getRunCreateCmd includes configId and workspaceId labels", () => {
        const cfg = withDefaults({ image: "ubuntu" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getRunCreateCmd("ubuntu", "test-container");

        const labelIndices = args.reduce<number[]>((acc, v, i) => v === "--label" ? [...acc, i + 1] : acc, []);
        expect(labelIndices.length).toBe(2);

        expect(args[labelIndices[0]]).includes(`configId=${cc.getConfigId()}`);
        expect(args[labelIndices[1]]).includes(`workspaceId=${getWorkspaceId(localWsf)}`);
    });

    test("getStage2BuildCmd includes configId and workspaceId labels", () => {
        expect(_hostUserInfo).toBeDefined();
        const hostUserInfo = _hostUserInfo!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

        const cfgPath = path.join(localWsf, ".devcontainer.json");
        const cfg = withDefaults({
            build: { dockerfile: "Dockerfile" },
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getStage2BuildCmd(hostUserInfo, "root");

        const labelIndices = args.reduce<number[]>((acc, v, i) => v === "--label" ? [...acc, i + 1] : acc, []);
        expect(labelIndices.length).toBe(2);

        expect(args[labelIndices[0]]).includes(`configId=${cc.getConfigId()}`);
        expect(args[labelIndices[1]]).includes(`workspaceId=${getWorkspaceId(localWsf)}`);
    });

    test("getStage2BuildCmd uses stage1 image as BASE_IMAGE for dockerfile configs", () => {
        expect(_hostUserInfo).toBeDefined();
        const hostUserInfo = _hostUserInfo!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

        const cfgPath = path.join(localWsf, ".devcontainer.json");
        const cfg = withDefaults({
            build: { dockerfile: "Dockerfile" },
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getStage2BuildCmd(hostUserInfo, "root");

        const baseImageArg = args.find(a => a.startsWith("BASE_IMAGE="));
        expect(baseImageArg).toBeDefined();

        const stage1Name = ContainerConfig._getStage1ImageName(localWsf);
        const stage2Name = ContainerConfig._getStage2ImageName(localWsf);
        expect(baseImageArg).toBe(`BASE_IMAGE=${stage1Name}`);
        expect(baseImageArg).not.toBe(`BASE_IMAGE=${stage2Name}`);
    });

    test("getInitializeCmd: string wraps in /bin/sh -c", () => {
        const cfg = withDefaults({ image: "ubuntu", initializeCommand: "echo hi" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        expect(cc.getInitializeCmd()).toStrictEqual(["/bin/sh", "-c", "echo hi"]);
    });

    test("getInitializeCmd: array passes through", () => {
        const cfg = withDefaults({ image: "ubuntu", initializeCommand: ["echo", "hi"] });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        expect(cc.getInitializeCmd()).toStrictEqual(["echo", "hi"]);
    });

    test("getInitializeCmd: undefined returns undefined", () => {
        const cfg = withDefaults({ image: "ubuntu" });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        expect(cc.getInitializeCmd()).toBeUndefined();
    });
});

describe("exec args", () => {
    const localWsf = "/tmp/dir";
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    test("withRemoteEnv=true injects --env and env -u", () => {
        const cfg = withDefaults({
            image: "ubuntu",
            remoteEnv: { EDITOR: "vim", UNSET_ME: null, KEEP: "yes" },
            remoteUser: "dev",
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getExecArgs("cid123", { PATH: "/usr/bin" }).join(" ");

        expect(args)
            .includes("--env EDITOR=vim")
            .includes("--env KEEP=yes")
            .includes("env -u UNSET_ME")
            .includes("-u dev");

        expect(args).not.includes("UNSET_ME=");
    });

    test("withRemoteEnv=false skips all remoteEnv injection", () => {
        const cfg = withDefaults({
            image: "ubuntu",
            remoteEnv: { EDITOR: "vim", UNSET_ME: null },
            remoteUser: "dev",
        });
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getExecArgs("cid123", {}, { tty: false, withRemoteEnv: false }).join(" ");

        expect(args)
            .includes("-u dev")
            .includes("cid123");

        expect(args).not.includes("--env");
        expect(args).not.includes("env -u");
    });

    test("unset null remoteEnv envs from devcontainer.json", () => {
        const newCfg = withDefaults({
            ...common,
            image: "ubuntu:24.04",
            remoteEnv: {
                Local1Env: "null",
                LOCALENV2: "HELLO",
                LOCALENV3: "undefined",
                Local2Env: null,
                LOCALENV4: "HELLO",
                LOCALENV5: null,
            },
        });

        const cc = ContainerConfig.create(localWsf, cfgPath, newCfg, {});

        expect(cc.getUnsetRemoteEnvArgs()).toStrictEqual([
            "env",
            "-u", "Local2Env",
            "-u", "LOCALENV5",
        ]);
    });
});

describe("normalizeLifecycleCmd", () => {
    test("undefined returns empty record", () => {
        expect(ContainerConfig.normalizeLifecycleCmd(undefined)).toStrictEqual({});
    });

    test("string wraps in /bin/sh -c", () => {
        expect(ContainerConfig.normalizeLifecycleCmd("echo hello")).toStrictEqual({
            string: ["/bin/sh", "-c", "echo hello"],
        });
    });

    test("array passes through", () => {
        expect(ContainerConfig.normalizeLifecycleCmd(["echo", "hello"])).toStrictEqual({
            array: ["echo", "hello"],
        });
    });

    test("record with string values wraps each in /bin/sh -c", () => {
        const result = ContainerConfig.normalizeLifecycleCmd({
            install: "npm install",
            build: "npm run build",
        });
        expect(result).toStrictEqual({
            install: ["/bin/sh", "-c", "npm install"],
            build: ["/bin/sh", "-c", "npm run build"],
        });
    });

    test("record with array values passes through", () => {
        const result = ContainerConfig.normalizeLifecycleCmd({
            install: ["npm", "install"],
            migrate: ["pg_migrate", "--up"],
        });
        expect(result).toStrictEqual({
            install: ["npm", "install"],
            migrate: ["pg_migrate", "--up"],
        });
    });

    test("record with mixed string and array values", () => {
        const result = ContainerConfig.normalizeLifecycleCmd({
            install: "npm install",
            migrate: ["pg_migrate", "--up"],
        });
        expect(result).toStrictEqual({
            install: ["/bin/sh", "-c", "npm install"],
            migrate: ["pg_migrate", "--up"],
        });
    });

    test("empty string returns empty record", () => {
        expect(ContainerConfig.normalizeLifecycleCmd("")).toStrictEqual({});
    });

    test("empty array returns empty record", () => {
        expect(ContainerConfig.normalizeLifecycleCmd([])).toStrictEqual({});
    });

    test("single-entry record", () => {
        const result = ContainerConfig.normalizeLifecycleCmd({
            only: "echo done",
        });
        expect(result).toStrictEqual({
            only: ["/bin/sh", "-c", "echo done"],
        });
    });

    test("record with string, array, and multi-word string values", () => {
        const result = ContainerConfig.normalizeLifecycleCmd({
            install: "npm install && npm run build",
            migrate: ["pg_migrate", "--up", "--verbose"],
            lint: "eslint .",
            test: ["vitest", "run"],
        });
        expect(result).toStrictEqual({
            install: ["/bin/sh", "-c", "npm install && npm run build"],
            migrate: ["pg_migrate", "--up", "--verbose"],
            lint: ["/bin/sh", "-c", "eslint ."],
            test: ["vitest", "run"],
        });
    });
});
