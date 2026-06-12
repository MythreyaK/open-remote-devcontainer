import { describe, expect, test, vi } from 'vitest';
import { Uri, window, workspace } from 'vscode';
import { z } from 'zod/mini';

import { ContainerConfig, interpolateLocalEnv, interpolateVars } from '../container';
import * as schema from '../../parser/schema';
import { initLog } from '../../extension/log';

describe("ContainerConfig tests", () => {
    (workspace as any).setWorkspaceFolders([
        { uri: Uri.file('/tmp/dir'), name: 'dir', index: 0 },
    ]);

    const spy = vi.spyOn(window, 'createOutputChannel');
    spy.mockReturnValue({
        info:  vi.fn(), // console.log,
        warn:  vi.fn(), // console.log,
        error: vi.fn(), // console.log,
    } as any);

    initLog("Remote - Devcontainer (tests)");

    test("test workspace mounts (default)", () => {
        {
            const cfg: schema.ImageDevcontainer = {
                name: "test",
                image: "ubuntu:24.04",
            };

            if (workspace.workspaceFolders !== undefined) {
                const cc = ContainerConfig.create(cfg, workspace.workspaceFolders[0].uri.fsPath, true);
                if (cc.isImageBased()) {
                    const createArgs = cc.getCreateArgs(cfg.image);
                    // console.log(createArgs);
                    expect(createArgs)
                        .contains("create")
                        .contains("-v", "/tmp/dir:/workspace/dir")
                        ;
                }
            }
            else {throw new Error("Bad workspace");}

            // console.log(cfg);
        }
    });

    test("test workspace mounts (explicit)", () => {
        {
            const cfg: schema.ImageDevcontainer = {
                name: "test",
                image: "ubuntu:24.04",
                // workspaceFolder: "/custom/subdir/repodir",
                workspaceMount: 'source=${localWorkspaceFolder}/sub-folder,target=/workspace,type=bind,consistency=cached"'
            };

            if (workspace.workspaceFolders !== undefined) {
                const cc = ContainerConfig.create(cfg, workspace.workspaceFolders[0].uri.fsPath, true);
                if (cc.isImageBased()) {
                    const createArgs = cc.getCreateArgs(cfg.image);
                    // console.log(createArgs);
                    expect(createArgs)
                        .contains("create")
                        .contains("--mount", cfg.workspaceMount)
                        ;
                }
            }
            else {throw new Error("Bad workspace");}

            // console.log(cfg);
        }
    });

    test("test workspace mounts (explicit)", () => {
        {
            const cfg: schema.ImageDevcontainer = {
                name: "test",
                image: "ubuntu:24.04",
                // workspaceFolder: "/custom/subdir/repodir",
                workspaceMount: 'source=${localWorkspaceFolder}/sub-folder,target=/workspace,type=bind,consistency=cached"'
            };

            if (workspace.workspaceFolders !== undefined) {
                const cc = ContainerConfig.create(cfg, workspace.workspaceFolders[0].uri.fsPath, true);
                if (cc.isImageBased()) {
                    const createArgs = cc.getCreateArgs(cfg.image);
                    // console.log(createArgs);
                    expect(createArgs)
                        .contains("create")
                        .contains("--mount", cfg.workspaceMount)
                        ;
                }
            }
            else {throw new Error("Bad workspace");}

            // console.log(cfg);
        }
    });

    test("variable interpolation", () => {
        {
            const localWsf = "/home/user/Projects/codium";
            const remoteWsf = "/workspace/projects/codium";

            const tests = [
                { test: 'PATH:${localWorkspaceFolder}', result: `PATH:${localWsf}` },
                { test: 'DIR=${containerWorkspaceFolder}', result: `DIR=${remoteWsf}` },
                { test: 'LOCAL_DIRNAME=${localWorkspaceFolderBasename}', result: "LOCAL_DIRNAME=codium" },
                { test: 'REMOTE_DIRNAME=${containerWorkspaceFolderBasename}', result: "REMOTE_DIRNAME=codium" },
            ];

            for (const test of tests) {
                expect(interpolateVars(test.test, localWsf, remoteWsf)).eq(test.result);
            }
        }
    });

    test("local env interpolation", () => {
        const procEnv = {
            "PATH": "/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin:/var/lib/snapd/snap/bin",
            "TERM": "xterm-256color",
            "SHELL": "/bin/bash",
        };

        {
            const tests = [
                { test: "/workspace/bin:${localEnv:PATH}", result: `/workspace/bin:${procEnv.PATH}` },
                { test: "${localEnv:PATH}:/workspace/bin:${localEnv:PATH}", result: `${procEnv.PATH}:/workspace/bin:${procEnv.PATH}` },
                { test: "/workspace/bin:${localEnv:MYPATH:/usr/bin:/opt/app}", result: `/workspace/bin:/usr/bin:/opt/app` },
                { test: "/workspace/bin:${localEnv:MYPATH:/usr/bin:/opt/app}:${localEnv:PATH}", result: `/workspace/bin:/usr/bin:/opt/app:${procEnv.PATH}` },
                { test: "${localEnv:SHELL:/bin/sh}", result: "/bin/bash" },
                { test: "${localEnv:MYSHELL:/bin/sh}", result: "/bin/sh" },
            ];

            for (const test of tests) {
                expect(interpolateLocalEnv(test.test, procEnv)).eq(test.result);
            }
        }
    });

    test("remote env interpolation", () => {
        // TODO
    });

    test("mixed local env and variable interpolation", () => {
        // TODO
    });


});
