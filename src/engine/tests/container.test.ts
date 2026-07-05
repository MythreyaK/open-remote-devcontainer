import path from "node:path";
import { ExtensionContext, Uri, window } from "vscode";
import { describe, expect, test, vi } from "vitest";

import * as schema from "../../parser/schema";
import { getLogSink } from "../../extension/log";
import { ContainerConfig, interpolateVars, interpolateLocal, interpolateContainer } from "../container";
import { getHostUserInfo, HostUserInfo } from "../../common/utils";

import { initMocks } from "../../tests/common";

initMocks();

describe("ContainerConfig tests", async () => {
    const localWsf = "/tmp/dir";
    const localWsfBase = path.parse(localWsf).base;
    const remoteWsf = "/workspace/dir";
    const remoteWsfBase = path.parse("/workspace/dir").base;
    const cfgPath = "/tmp/dir/.devcontainer/devcontainer.json";

    const hostUserInfo: HostUserInfo = await (async () => {
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

    const sanityCheck = (_lsf: string, _cfg: string) => {
        const resolvedWsf = path.resolve(_lsf);
        const resolvedCfg = path.resolve(_cfg);
        expect(resolvedCfg.startsWith(resolvedWsf + "/")).toBe(true);

        const relativeTo = path.relative(resolvedWsf, resolvedCfg);
        expect(relativeTo).toBeOneOf([
            ".devcontainer/devcontainer.json",
            ".devcontainer.json",
            // ".config/devcontainer.json",
        ]);
    };

    test("local workspace dir (sanity check)", () => {
        sanityCheck(localWsf, cfgPath);
    });

    test("test workspace mounts (default)", () => {
        {
            const cfg: schema.ImageDevcontainer = {
                name: "test",
                image: "ubuntu:24.04",
            };

            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
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

            const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
            expect(cc.isImageBased()).toBe(true);

            if (cc.isImageBased()) {
                const createArgs = cc.getRunCreateCmd(cfg.image, "foobar");

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

    test("exec unset null remoteEnv envs from devcontainer.json", () => {
        const newCfg = {
            ...imgCfg,
            remoteEnv: {
                Local1Env: "null",
                LOCALENV2: "HELLO",
                LOCALENV3: "undefined",
                Local2Env: null,
                LOCALENV4: "HELLO",
                LOCALENV5: null,
            },
        };

        const cc = ContainerConfig.create(localWsf, cfgPath, newCfg, {});

        expect(cc.getUnsetRemoteEnvArgs()).toStrictEqual([
            "env",
            "-u", "Local2Env",
            "-u", "LOCALENV5",
        ]);
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

    test("build dockerfile implicit context dir (dockerfile based)", () => {
        const cc = ContainerConfig.create(localWsf, cfgPath, dockerfileCfg, localEnv);
        expect(cc.getResolvedBuildcontextDir()).toBe("/tmp/dir/.devcontainer");
        expect(cc.getResolvedDockerfilePath()).toBe("/tmp/dir/.devcontainer/dockerfile");
    });

    test("build dockerfile explicit context dir (dockerfile based)", () => {
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

    test("build dockerfile explicit context and dockerfile dir (dockerfile based)", () => {
        const newCfg: schema.DockerfileDevcontainer = {
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
        };

        const cc = ContainerConfig.create(localWsf, cfgPath, newCfg, localEnv);
        const execCmd = cc.getExecArgs(cc.getConfigId(), {}).join(" ");
        expect(execCmd).includes(`${cc.getConfigId()} env -u Local2Env -u LOCALENV5`);
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

    test("run cmd: string mounts use '--mount' flag", () => {
        const cc = ContainerConfig.create(localWsf, cfgPath, dockerfileCfg, localEnv);
        expect(cc.isImageBased()).toBe(false);
        expect(cc.isDockerfileBased()).toBe(true);

        if (cc.isDockerfileBased()) {
            const runArgs = cc.getRunCreateCmd(imgCfg.image, "foobar").join(" ");
            expect(runArgs)
                .includes("run ")
                .includes(" --mount source=/c,target=/d,type=bind ")
                .includes(" -v /a:/b ");
        }
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

            expect(buildArgs).not.includes(" --pull ");
            expect(buildArgs).not.includes(" --no-cache ");
        }
    });

    test("build image cmd (noCache)", () => {
        const localWsf = __dirname;
        const localWsfBase = path.parse(localWsf).base;
        const cfgPath = path.join(localWsf, ".devcontainer.json");
        sanityCheck(localWsf, cfgPath);

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
                .includes(" --pull ")
                .includes(" --no-cache ");

            expect(stage2.endsWith(` ${__dirname}`)).toBe(true);
        }
    });

    test("exec args: withRemoteEnv=true injects --env and env -u", () => {
        const cfg: schema.ImageDevcontainer = {
            image: "ubuntu",
            remoteEnv: { EDITOR: "vim", UNSET_ME: null, KEEP: "yes" },
            remoteUser: "dev",
        };
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getExecArgs("cid123", { PATH: "/usr/bin" }).join(" ");

        expect(args)
            .includes("--env EDITOR=vim")
            .includes("--env KEEP=yes")
            .includes("env -u UNSET_ME")
            .includes("-u dev");

        expect(args).not.includes("UNSET_ME=");
    });

    test("exec args: withRemoteEnv=false skips all remoteEnv injection", () => {
        const cfg: schema.ImageDevcontainer = {
            image: "ubuntu",
            remoteEnv: { EDITOR: "vim", UNSET_ME: null },
            remoteUser: "dev",
        };
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getExecArgs("cid123", {}, { tty: false, withRemoteEnv: false }).join(" ");

        expect(args)
            .includes("-u dev")
            .includes("cid123");

        expect(args).not.includes("--env");
        expect(args).not.includes("env -u");
    });

    test("getResolvedRemoteEnv excludes null values", () => {
        const cfg: schema.ImageDevcontainer = {
            image: "ubuntu",
            remoteEnv: { KEEP: "yes", DROP: null, ALSO_KEEP: "yep" },
        };
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const resolved = cc.getResolvedRemoteEnv({});

        expect("KEEP" in resolved).toBe(true);
        expect("ALSO_KEEP" in resolved).toBe(true);
        expect("DROP" in resolved).toBe(false);
    });

    test("getUnsetRemoteEnvArgs returns empty when no nulls", () => {
        const cfg: schema.ImageDevcontainer = {
            image: "ubuntu",
            remoteEnv: { A: "1", B: "2" },
        };
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        expect(cc.getUnsetRemoteEnvArgs()).toStrictEqual([]);
    });

    test("getUnsetRemoteEnvArgs returns empty when no remoteEnv", () => {
        const cfg: schema.ImageDevcontainer = { image: "ubuntu" };
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        expect(cc.getUnsetRemoteEnvArgs()).toStrictEqual([]);
    });

    test("getResolvedRemoteUser priority chain", () => {
        const base: schema.ImageDevcontainer = { image: "ubuntu" };
        const cc1 = ContainerConfig.create(localWsf, cfgPath, base, {});
        expect(cc1.getResolvedRemoteUser("imguser")).toBe("imguser");
        expect(cc1.getResolvedRemoteUser(undefined)).toBe("root");

        const withRemote: schema.ImageDevcontainer = { image: "ubuntu", remoteUser: "alice" };
        const cc2 = ContainerConfig.create(localWsf, cfgPath, withRemote, {});
        expect(cc2.getResolvedRemoteUser("imguser")).toBe("alice");
        expect(cc2.getResolvedRemoteUser(undefined)).toBe("alice");

        const withContainer: schema.ImageDevcontainer = { image: "ubuntu", containerUser: "bob" };
        const cc3 = ContainerConfig.create(localWsf, cfgPath, withContainer, {});
        expect(cc3.getResolvedRemoteUser("imguser")).toBe("bob");
        expect(cc3.getResolvedRemoteUser(undefined)).toBe("bob");

        const withBoth: schema.ImageDevcontainer = { image: "ubuntu", containerUser: "bob", remoteUser: "alice" };
        const cc4 = ContainerConfig.create(localWsf, cfgPath, withBoth, {});
        expect(cc4.getResolvedRemoteUser("imguser")).toBe("alice");
    });

    test("getConfigId is stable when non-id fields change", () => {
        // TODO: handle other fields as well
        const base: schema.ImageDevcontainer = { image: "ubuntu", remoteUser: "dev" };
        const cc1 = ContainerConfig.create(localWsf, cfgPath, base, {});

        const withPull: schema.ImageDevcontainer = { ...base, pull: true };
        const withUserEnvProbe: schema.ImageDevcontainer = { ...base, userEnvProbe: "loginShell" };

        for (const cfg of [withPull, withUserEnvProbe]) {
            expect(ContainerConfig.create(localWsf, cfgPath, cfg, {}).getConfigId()).eq(cc1.getConfigId());
        }
    });

    test("getConfigId changes when id-relevant fields change", () => {
        // TODO: handle other fields as well
        const base: schema.ImageDevcontainer = { image: "ubuntu", remoteUser: "dev" };
        const baseId = ContainerConfig.create(localWsf, cfgPath, base, {}).getConfigId();

        const variants: schema.ImageDevcontainer[] = [
            { ...base, image: "debian:12" },
            { ...base, name: "different" },
            { ...base, runArgs: ["--privileged"] },
            { ...base, appPort: [8080] },
            { ...base, init: true },
            { ...base, privileged: true },
            { ...base, capAdd: ["SYS_PTRACE"] },
            { ...base, securityOpt: ["seccomp=unconfined"] },
            { ...base, overrideCommand: true },
            { ...base, initializeCommand: "echo init" },
            { ...base, onCreateCommand: "echo create" },
            { ...base, updateContentCommand: "echo update" },
            { ...base, postCreateCommand: "echo post" },
            { ...base, postStartCommand: "echo start" },
            { ...base, postAttachCommand: "echo attach" },
            { ...base, workspaceFolder: "/custom", workspaceMount: "source=/a,target=/custom" },
            { ...base, mounts: [{ type: "bind" as const, source: "/a", target: "/b" }] },
            { ...base, containerEnv: { FOO: "bar" } },
            { ...base, containerUser: "nobody" },
            { ...base, updateRemoteUserUID: true },
            { ...base, remoteEnv: { BAZ: "qux" } },
            { ...base, remoteUser: "alice" },
        ];

        for (const cfg of variants) {
            const id = ContainerConfig.create(localWsf, cfgPath, cfg, {}).getConfigId();
            expect(id, `expected configId to change for ${JSON.stringify(cfg)}`).not.eq(baseId);
        }
    });

    test("volume mount without source produces no undefined in args", () => {
        const cfg: schema.ImageDevcontainer = {
            image: "ubuntu",
            mounts: [{ type: "volume" as const, target: "/data" }],
        };
        const cc = ContainerConfig.create(localWsf, cfgPath, cfg, {});
        const args = cc.getRunCreateCmd("ubuntu", "test").join(" ");
        expect(args).includes("-v /data");
        expect(args).not.includes("undefined");
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

describe("context and dockerfile resolution", () => {
    const debugMode = process.env.DEBUG_TESTS;
    const spy = vi.spyOn(window, "createOutputChannel");
    spy.mockReturnValue({
        info: debugMode !== undefined ? console.log : vi.fn(),
        warn: debugMode !== undefined ? console.log : vi.fn(),
        error: debugMode !== undefined ? console.log : vi.fn(),
    } as any);

    const sanityCheck = (_lsf: string, _cfg: string) => {
        const resolvedWsf = path.resolve(_lsf);
        const resolvedCfg = path.resolve(_cfg);
        expect(resolvedCfg.startsWith(resolvedWsf + "/")).toBe(true);

        const relativeTo = path.relative(resolvedWsf, resolvedCfg);
        expect(relativeTo).toBeOneOf([
            ".devcontainer/devcontainer.json",
            ".devcontainer.json",
            // ".config/devcontainer.json",
        ]);
    };

    const cases: {
        label: string,
        cfgPath: string,
        localEnv: NodeJS.ProcessEnv,
        dockerfile: string,
        context: string | undefined,
        expectedCtx: string,
        expectedDockerfile: string,
    }[] = [
        {
            label: "implicit context, relative dockerfile",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: undefined,
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "implicit context, nested relative dockerfile",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "docker/Dockerfile.dev",
            context: undefined,
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/.devcontainer/docker/Dockerfile.dev",
        },
        {
            label: "context '..' (parent), relative dockerfile",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "..",
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "context '..' (parent), dockerfile also '..'",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "../Dockerfile",
            context: "..",
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/Dockerfile",
        },
        {
            label: "explicit context '.', same as implicit",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: ".",
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "explicit relative context subdir",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "build",
            expectedCtx: "/tmp/dir/.devcontainer/build",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "absolute context, relative dockerfile",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "/opt/build",
            expectedCtx: "/opt/build",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "absolute dockerfile, implicit context",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "/opt/Dockerfile",
            context: undefined,
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/opt/Dockerfile",
        },
        {
            label: "both absolute",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "/opt/Dockerfile",
            context: "/opt/build",
            expectedCtx: "/opt/build",
            expectedDockerfile: "/opt/Dockerfile",
        },
        {
            label: "flat devcontainer.json, implicit context",
            cfgPath: "/tmp/dir/.devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: undefined,
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/Dockerfile",
        },
        {
            label: "flat devcontainer.json, context '.devcontainer'",
            cfgPath: "/tmp/dir/.devcontainer.json",
            localEnv: {},
            dockerfile: ".devcontainer/Dockerfile",
            context: ".devcontainer",
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        // --- variable interpolation cases ---
        {
            label: "context uses ${localWorkspaceFolder}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "${localWorkspaceFolder}",
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "context uses ${localWorkspaceFolderBasename}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "../${localWorkspaceFolderBasename}",
            expectedCtx: "/tmp/dir/dir",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "dockerfile uses ${localWorkspaceFolder}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "${localWorkspaceFolder}/Dockerfile",
            context: undefined,
            expectedCtx: "/tmp/dir/.devcontainer",
            expectedDockerfile: "/tmp/dir/Dockerfile",
        },
        {
            label: "context uses ${localEnv:VAR}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: { BUILD_DIR: "/opt/build" },
            dockerfile: "Dockerfile",
            context: "${localEnv:BUILD_DIR}",
            expectedCtx: "/opt/build",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "${localEnv:VAR} with default, var exists",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: { CTX: "custom" },
            dockerfile: "Dockerfile",
            context: "${localEnv:CTX:fallback}",
            expectedCtx: "/tmp/dir/.devcontainer/custom",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "${localEnv:VAR} with default, var missing",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "Dockerfile",
            context: "${localEnv:CTX:fallback}",
            expectedCtx: "/tmp/dir/.devcontainer/fallback",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
        {
            label: "both use ${localWorkspaceFolder}",
            cfgPath: "/tmp/dir/.devcontainer/devcontainer.json",
            localEnv: {},
            dockerfile: "${localWorkspaceFolder}/.devcontainer/Dockerfile",
            context: "${localWorkspaceFolder}",
            expectedCtx: "/tmp/dir",
            expectedDockerfile: "/tmp/dir/.devcontainer/Dockerfile",
        },
    ];

    const localWsf = "/tmp/dir";

    for (const c of cases) {
        const cfg: schema.DockerfileDevcontainer = {
            build: {
                dockerfile: c.dockerfile,
                ...(c.context !== undefined ? { context: c.context } : {}),
            },
        };

        test(`test: ${c.label}`, () => {
            const cc = ContainerConfig.create(localWsf, c.cfgPath, cfg, c.localEnv);
            expect(cc.getResolvedBuildcontextDir(), c.label).toBe(c.expectedCtx);
            expect(cc.getResolvedDockerfilePath(), c.label).toBe(c.expectedDockerfile);
        });
    }
});
