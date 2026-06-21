import path from "node:path";
import { Uri, window, workspace } from "vscode";
import { describe, expect, test, vi } from "vitest";

import * as schema from "../../parser/schema";
import { initLog } from "../../extension/log";
import { ContainerConfig, interpolateVars, interpolateLocal, interpolateContainer } from "../container";


describe("ContainerConfig tests", () => {
    (workspace as any).setWorkspaceFolders([
        { uri: Uri.file("/tmp/dir"), name: "dir", index: 0 },
    ]);

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

            const cc = ContainerConfig.create(getActiveWorkspace(), cfg, {});
            expect(cc.isImageBased()).toBe(true);

            if (cc.isImageBased()) {
                const createArgs = cc.getRunCreateCmd(cfg.image, "foobar");

                expect(cc.getRemoteMountDir()).eq("/workspace/dir");
                expect(createArgs[0]).eq("run");
                expect(createArgs[1]).eq("-d");
                expect(createArgs)
                    .contains("/tmp/dir:/workspace/dir");
            }

            // console.log(cfg);
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

            const cc = ContainerConfig.create(getActiveWorkspace(), cfg, {});
            expect(cc.isImageBased()).toBe(true);

            if (cc.isImageBased()) {
                const createArgs = cc.getRunCreateCmd(cfg.image, "foobar");
                // console.log(createArgs);

                expect(cc.getRemoteMountDir()).eq("/workspace/dir");
                expect(createArgs[0]).eq("run");
                expect(createArgs[1]).eq("-d");
                expect(createArgs)
                    .contains(`${cfg.workspaceMount?.replace("${localWorkspaceFolder}", getActiveWorkspace())}`)
                    .not.contains("${localWorkspaceFolder}");
            }

            // console.log(cfg);
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

        const localWsp = getActiveWorkspace();
        const localWspBase = path.parse(getActiveWorkspace()).base;
        const remoteWsp = "/workspace/dir";
        const remoteWspBase = path.parse("/workspace/dir").base;

        {
            const tests = [
                { test: "${containerWorkspaceFolder}:${localEnv:PATH}", result: `${remoteWsp}:${procEnv.PATH}` },
                { test: "${localWorkspaceFolder}:${localEnv:PATH}:${containerWorkspaceFolder}:${localEnv:PATH}", result: `${localWsp}:${procEnv.PATH}:${remoteWsp}:${procEnv.PATH}` },
                { test: "${localWorkspaceFolder}:${containerWorkspaceFolder}:${localEnv:MYPATH:/usr/bin:/opt/app}", result: `${localWsp}:${remoteWsp}:/usr/bin:/opt/app` },
                { test: "${localWorkspaceFolder}:${containerWorkspaceFolder}:${localEnv:MYPATH:/usr/bin:/opt/app}:${localEnv:PATH}", result: `${localWsp}:${remoteWsp}:/usr/bin:/opt/app:${procEnv.PATH}` },
                { test: "${localEnv:SHELL:/bin/sh}", result: "/bin/bash" },
                { test: "${localEnv:MYSHELL:/bin/sh}", result: "/bin/sh" },
                { test: "${localEnv:EMPTY}", result: "" },
                { test: "${localEnv:EMPTY:empty}", result: "" },
                { test: "${localEnv:HUMPTY:}", result: "" },
                { test: "${localEnv:HUMPTY:dumpty}", result: "dumpty" },
                {
                    test: "${localEnv:SHELL:/bin/sh}:${localEnv:MYSHELL:/bin/fish}:${localWorkspaceFolder}:${localWorkspaceFolderBasename}:${containerWorkspaceFolder}:${containerWorkspaceFolderBasename}",
                    result: `/bin/bash:/bin/fish:${localWsp}:${localWspBase}:${remoteWsp}:${remoteWspBase}`,
                },
            ];

            for (const test of tests) {
                expect(interpolateLocal(test.test, localWsp, remoteWsp, procEnv)).eq(test.result);
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

        const remoteWsp = "/workdir/dir";
        const remoteWspBase = "dir";
        const localWsp = getActiveWorkspace();
        const localWspBase = path.parse(getActiveWorkspace()).base;

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
                    result: `${localEnv.LOC}:${containerEnv.LOC}${localWsp}:${remoteWsp}:${localWspBase}:${remoteWspBase}`,
                },
                {
                    test: "${containerEnv:SHELL:/bin/sh}:${containerEnv:MYSHELL:/bin/fish}:${localEnv:SHELL:/bin/sh}:${localEnv:MYSHELL:/bin/myfish}:${localWorkspaceFolder}:${localWorkspaceFolderBasename}:${containerWorkspaceFolder}:${containerWorkspaceFolderBasename}",
                    result: `/bin/zsh:/bin/fish:/bin/bash:/bin/myfish:${localWsp}:${localWspBase}:${remoteWsp}:${remoteWspBase}`,
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
                expect(interpolateContainer(test.test, localWsp, remoteWsp, localEnv, containerEnv)).eq(test.result);
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
    };

    const localWsp = getActiveWorkspace();
    const localWspBase = path.parse(getActiveWorkspace()).base;
    const remoteWsp = "/workspace/dir";
    const remoteWspBase = path.parse("/workspace/dir").base;

    test("create container cmd", () => {
        const cc = ContainerConfig.create(localWsp, imgCfg, localEnv);
        expect(cc.isImageBased()).toBe(true);
        expect(cc.isDockerfileBased()).toBe(false);

        if (cc.isImageBased()) {
            const createArgs = cc.getRunCreateCmd(imgCfg.image, "foobar").join(" ");
            expect(createArgs)
                .includes("run -d ")
                .includes("-u foo:foo ")
                .includes("-p 100 -p 123:456 -p 5040:5012 ")
                .includes(`-v ${localWsp}:${localEnv.HOME}/projects/${localWspBase} `)
                .includes("--mount source=/tmp/dir/sub-folder,target=/workspace/dir,type=bind,consistency=cached ")
                .includes("--env MY_ENV1=MY_VAL1=/foo/bar --env HOME=/foo/bar ")
                .includes("--device /dev/kfd --pid host ")
                .includes("--cap-add CAP_BPF --cap-add CAP_CHOWN ")
                .includes("--security-opt seccomp=unconfined --security-opt no-new-privileges=true ");
        }
    });

    test("build image cmd", () => {
        const cc = ContainerConfig.create(localWsp, dockerfileCfg, localEnv);
        expect(cc.isImageBased()).toBe(false);
        expect(cc.isDockerfileBased()).toBe(true);

        if (cc.isDockerfileBased()) {
            const buildArgs = cc.getBuildCmd().join(" ");
            expect(buildArgs)
                .includes("build ")
                .includes(`--build-arg ARG1=VAL1 --build-arg ARG2=${localWspBase} --build-arg HOMEDIR=${localWsp}`)
                .includes("-f dockerfile")
                .includes(localWsp);
        }
    });

    test("exec in container args", () => {

    });
});
