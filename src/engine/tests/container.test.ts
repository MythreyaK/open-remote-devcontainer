import path from "node:path";
import { window } from "vscode";
import { describe, expect, test, vi } from "vitest";

import * as schema from "../../parser/schema";
import { initLog } from "../../extension/log";
import { ContainerConfig, interpolateVars, interpolateLocal, interpolateContainer } from "../container";

describe("ContainerConfig tests", () => {
    const localWsf = "/tmp/dir";
    const localWsfBase = path.parse(localWsf).base;
    const remoteWsf = "/workspace/dir";
    const remoteWsfBase = path.parse("/workspace/dir").base;

    const spy = vi.spyOn(window, "createOutputChannel");
    spy.mockReturnValue({
        info: vi.fn(), // console.log,
        warn: vi.fn(), // console.log,
        error: vi.fn(), // console.log,
    } as any);

    initLog("Remote - Devcontainer (tests)");

    test("test workspace mounts (default)", () => {
        {
            const cfg: schema.ImageDevcontainer = {
                name: "test",
                image: "ubuntu:24.04",
            };

            const cc = ContainerConfig.create(localWsf, cfg, {});
            expect(cc.isImageBased()).toBe(true);

            if (cc.isImageBased()) {
                const createArgs = cc.getRunCreateCmd(cfg.image, "foobar");

                expect(cc.getRemoteMountDir()).eq("/workspace/dir");
                expect(createArgs[0]).eq("run");
                expect(createArgs[1]).eq("-d");
                expect(createArgs)
                    .contains("/tmp/dir:/workspace/dir");
            }
        }
    });

    test("test workspace mounts (explicit)", () => {
        {
            const cfg: schema.ImageDevcontainer = {
                name: "test",
                image: "ubuntu:24.04",
                // workspaceFolder: "/custom/subdir/repodir",
                workspaceMount: "source=${localWorkspaceFolder}/sub-folder,target=/workspace/dir,type=bind,consistency=cached",
            };

            const cc = ContainerConfig.create(localWsf, cfg, {});
            expect(cc.isImageBased()).toBe(true);

            if (cc.isImageBased()) {
                const createArgs = cc.getRunCreateCmd(cfg.image, "foobar");
                // console.log(createArgs);

                expect(cc.getRemoteMountDir()).eq("/workspace/dir");
                expect(createArgs[0]).eq("run");
                expect(createArgs[1]).eq("-d");
                expect(createArgs)
                    .contains(`${cfg.workspaceMount?.replace("${localWorkspaceFolder}", localWsf)}`)
                    .not.contains("${localWorkspaceFolder}");
            }
        }
    });

    test("variable interpolation", () => {
        {
            const localWsf = "/home/user/Projects/codium";
            const remoteWsf = "/workspace/projects/codium";

            const tests = [
                { test: "PATH:${localWorkspaceFolder}", result: `PATH:${localWsf}` },
                { test: "DIR=${containerWorkspaceFolder}", result: `DIR=${remoteWsf}` },
                { test: "LOCAL_DIRNAME=${localWorkspaceFolderBasename}", result: "LOCAL_DIRNAME=codium" },
                { test: "REMOTE_DIRNAME=${containerWorkspaceFolderBasename}", result: "REMOTE_DIRNAME=codium" },
            ];

            for (const test of tests) {
                expect(interpolateVars(test.test, localWsf, remoteWsf)).eq(test.result);
            }
        }
    });

    test("localEnv and var interpolation", () => {
        const procEnv = {
            PATH: "/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin:/var/lib/snapd/snap/bin",
            TERM: "xterm-256color",
            SHELL: "/bin/bash",
            EMPTY: "",
        };

        {
            const tests = [
                { test: "${containerWorkspaceFolder}:${localEnv:PATH}", result: `${remoteWsf}:${procEnv.PATH}` },
                { test: "${localWorkspaceFolder}:${localEnv:PATH}:${containerWorkspaceFolder}:${localEnv:PATH}", result: `${localWsf}:${procEnv.PATH}:${remoteWsf}:${procEnv.PATH}` },
                { test: "${localWorkspaceFolder}:${containerWorkspaceFolder}:${localEnv:MYPATH:/usr/bin:/opt/app}", result: `${localWsf}:${remoteWsf}:/usr/bin:/opt/app` },
                { test: "${localWorkspaceFolder}:${containerWorkspaceFolder}:${localEnv:MYPATH:/usr/bin:/opt/app}:${localEnv:PATH}", result: `${localWsf}:${remoteWsf}:/usr/bin:/opt/app:${procEnv.PATH}` },
                { test: "${localEnv:SHELL:/bin/sh}", result: "/bin/bash" },
                { test: "${localEnv:MYSHELL:/bin/sh}", result: "/bin/sh" },
                { test: "${localEnv:EMPTY}", result: "" },
                { test: "${localEnv:EMPTY:empty}", result: "" },
                { test: "${localEnv:HUMPTY:}", result: "" },
                { test: "${localEnv:HUMPTY:dumpty}", result: "dumpty" },
                {
                    test: "${localEnv:SHELL:/bin/sh}:${localEnv:MYSHELL:/bin/fish}:${localWorkspaceFolder}:${localWorkspaceFolderBasename}:${containerWorkspaceFolder}:${containerWorkspaceFolderBasename}",
                    result: `/bin/bash:/bin/fish:${localWsf}:${localWsfBase}:${remoteWsf}:${remoteWsfBase}`,
                },
            ];

            for (const test of tests) {
                expect(interpolateLocal(test.test, localWsf, remoteWsf, procEnv)).eq(test.result);
            }
        }
    });

    test("localEnv, containerEnv, and var interpolation", () => {
        const localEnv = {
            PATH: "/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin:/var/lib/snapd/snap/bin",
            TERM: "xterm-256color",
            SHELL: "/bin/bash",
            HOME: "/home/username",
            LOC: "LOCAL",
            EMPTY: "",
        };
        const containerEnv = {
            PATH: "/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin",
            TERM: "xterm-256color",
            SHELL: "/bin/zsh",
            HOME: "/home/root",
            LOC: "REMOTE",
            EMPTY: "",
        };

        const remoteWsf = "/workdir/dir";
        const remoteWsfBase = "dir";

        {
            const tests = [
                {
                    test: "${localEnv:LOC}:${containerEnv:LOC}:${containerWorkspaceFolder}:${localEnv:PATH}",
                    result: `LOCAL:REMOTE:/workdir/dir:${localEnv.PATH}`,
                },
                {
                    test: "${localEnv:LOC}:${containerEnv:LOC}:${localEnv:PATH}:${containerEnv:PATH}",
                    result: `${localEnv.LOC}:${containerEnv.LOC}:${localEnv.PATH}:${containerEnv.PATH}`,
                },
                {
                    test: "${localEnv:LOC}:${containerEnv:LOC}${localWorkspaceFolder}:${containerWorkspaceFolder}:${localWorkspaceFolderBasename}:${containerWorkspaceFolderBasename}",
                    result: `${localEnv.LOC}:${containerEnv.LOC}${localWsf}:${remoteWsf}:${localWsfBase}:${remoteWsfBase}`,
                },
                {
                    test: "${containerEnv:SHELL:/bin/sh}:${containerEnv:MYSHELL:/bin/fish}:${localEnv:SHELL:/bin/sh}:${localEnv:MYSHELL:/bin/myfish}:${localWorkspaceFolder}:${localWorkspaceFolderBasename}:${containerWorkspaceFolder}:${containerWorkspaceFolderBasename}",
                    result: `/bin/zsh:/bin/fish:/bin/bash:/bin/myfish:${localWsf}:${localWsfBase}:${remoteWsf}:${remoteWsfBase}`,
                },
                { test: "${localEnv:EMPTY}", result: "" },
                { test: "${localEnv:EMPTY:empty}", result: "" },
                { test: "${localEnv:HUMPTY:}", result: "" },
                { test: "${localEnv:HUMPTY:dumpty}", result: "dumpty" },
                { test: "${containerEnv:EMPTY}", result: "" },
                { test: "${containerEnv:EMPTY:empty}", result: "" },
                { test: "${containerEnv:HUMPTY:}", result: "" },
                { test: "${containerEnv:HUMPTY:dumpty}", result: "dumpty" },
            ];

            for (const test of tests) {
                expect(interpolateContainer(test.test, localWsf, remoteWsf, localEnv, containerEnv)).eq(test.result);
            }
        }
    });

    const localEnv = {
        APP_PORT: "5040",
        HOME: "/foo/bar",
    } as NodeJS.ProcessEnv;

    const containerEnv = {

    } as NodeJS.ProcessEnv;

    const common: schema.DevcontainerCommon = {
        name: "foobar",
        containerUser: "foo",
        appPort: [100, "123:456", "${localEnv:APP_PORT:4040}:${localEnv:FOO_PORT:5012}"],
        mounts: [
            { type: "bind", source: "${localWorkspaceFolder}", target: "${localEnv:HOME:/home/root}/projects/${localWorkspaceFolderBasename}" },
        ],
        workspaceMount: "source=${localWorkspaceFolder}/sub-folder,target=/workspace/dir,type=bind,consistency=cached",
        containerEnv: { MY_ENV1: "MY_VAL1=${localEnv:HOME}", HOME: "${localEnv:HOME}" },
        runArgs: ["--device", "/dev/kfd", "--pid", "host"],
        capAdd: ["CAP_BPF", "CAP_CHOWN"],
        securityOpt: ["seccomp=unconfined", "no-new-privileges=true"],
    };

    const imgCfg: schema.ImageDevcontainer = {
        ...common,
        image: "ubuntu:24.04",
    };

    const dockerfileCfg: schema.DockerfileDevcontainer = {
        ...common,
        build: {
            dockerfile: "dockerfile",
            context: "${localWorkspaceFolder}",
            args: { ARG1: "VAL1", ARG2: "${localWorkspaceFolderBasename}", HOMEDIR: "${localWorkspaceFolder}" },
        },
        mounts: [
            {
                type: "bind",
                source: "/a",
                target: "/b",
            },
            "source=/c,target=/d,type=bind",
        ],
    };

    test("create container cmd", () => {
        const cc = ContainerConfig.create(localWsf, imgCfg, localEnv);
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

    test("string mounts use '--mount' flag", () => {
        const cc = ContainerConfig.create(localWsf, dockerfileCfg, localEnv);
        expect(cc.isImageBased()).toBe(false);
        expect(cc.isDockerfileBased()).toBe(true);

        if (cc.isDockerfileBased()) {
            const buildArgs = cc.getRunCreateCmd(imgCfg.image, "foobar").join(" ");
            expect(buildArgs)
                .includes("run ")
                .includes(" --mount source=/c,target=/d,type=bind ")
                .includes(" -v /a:/b ")
                .includes(localWsf);
        }
    });

    test("build image cmd", () => {
        const cc = ContainerConfig.create(localWsf, dockerfileCfg, localEnv);
        expect(cc.isImageBased()).toBe(false);
        expect(cc.isDockerfileBased()).toBe(true);

        if (cc.isDockerfileBased()) {
            const buildArgs = cc.getBuildCmd().join(" ");
            expect(buildArgs)
                .includes("build ")
                .includes(`--build-arg ARG1=VAL1 --build-arg ARG2=${localWsfBase} --build-arg HOMEDIR=${localWsf}`)
                .includes("-f dockerfile")
                .includes(localWsf);

            expect(buildArgs).not.includes(" --pull ");
            expect(buildArgs).not.includes(" --no-cache ");
        }
    });

    test("build image cmd (noCache)", async () => {
        const localWsf = __dirname;
        const localWsfBase = path.parse(__dirname).base;
        const cc = ContainerConfig.create(localWsf, dockerfileCfg, localEnv);
        expect(cc.isImageBased()).toBe(false);
        expect(cc.isDockerfileBased()).toBe(true);

        if (cc.isDockerfileBased()) {
            const stage1 = cc.getBuildCmd({ noCache: true }).join(" ");
            expect(stage1)
                .includes("build ")
                .includes(`--build-arg ARG1=VAL1 --build-arg ARG2=${localWsfBase} --build-arg HOMEDIR=${localWsf}`)
                .includes(" --pull ")
                .includes(" --no-cache ")
                .includes("-f dockerfile")
                .includes(localWsf);

            const stage2 = (await cc.getStage2BuildCmd("root", { noCache: true })).join(" ");
            expect(stage2)
                .includes("build ")
                .includes(" --pull ")
                .includes(" --no-cache ")
                .includes("Dockerfile ")
                .includes(localWsf);
        }
    });

    // test("exec in container args", () => {
    //     // TODO
    // });
});
