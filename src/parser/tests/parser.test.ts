import { describe, expect, test } from "vitest";
import * as assert from "assert";

import * as parser from "../schema";

describe("Parser tests", () => {
    test("Parse mounts", () => {
        {
            const jsondata = {
                type: "bind",
                source: "/home/username/dir",
                target: "/workspace/dir",
                options: "ro,z",
            };

            const p = parser.Mount_z.safeParse(jsondata);
            expect(p.success).toBe(true);

            if (!p.success) {
                throw new Error("Expected parse to work");
            }

            const o = p.data;
            expect(o.type).eq("bind");
            expect(o.source).eq("/home/username/dir");
            expect(o.target).eq("/workspace/dir");
            expect(o.options).eq("ro,z");
        }
        {
            const jsondata = {
                type: "volume",
                target: "/workspace/dir",
                options: "ro",
            };

            const p = parser.Mount_z.safeParse(jsondata);
            if (!p.success) {
                throw new Error("Expected parse to work");
            }

            const o = p.data;
            expect(o.type).eq("volume");
            expect(o.source).eq(undefined);
            expect(o.target).eq("/workspace/dir");
            expect(o.options).eq("ro");
        }
        {
            const jsondata = {
                type: "somethingelse",
                target: "/workspace/dir",
                options: "ro",
            };

            const p = parser.Mount_z.safeParse(jsondata);
            expect(p.success).toBe(false);
        }
    });

    test("Parse both build syntax", () => {
        {
            const jsondata = {
                name: "devc",
                build: {
                    dockerfile: "ubuntu",
                    context: "dir",
                    args: {
                        ARG1: "VAL1",
                    },
                },
            };

            const o = parser.ConfigSchema.parse(jsondata);

            expect(o).toHaveProperty("name", "devc");
            expect(o).toHaveProperty("build.dockerfile", "ubuntu");
            expect(o).toHaveProperty("build.context", "dir");
            expect(o).toHaveProperty("build.args.ARG1", "VAL1");
        }
        {
            const jsondata = {
                name: "devc",
                dockerFile: "ubuntu",
                context: "dir",
                build: {
                    args: {
                        ARG1: "VAL1",
                    },
                },
            };

            const o = parser.ConfigSchema.parse(jsondata);

            // we transform in the parser to this "new" format
            expect(o).toHaveProperty("name", "devc");
            expect(o).toHaveProperty("build.dockerfile", "ubuntu");
            expect(o).toHaveProperty("build.context", "dir");
            expect(o).toHaveProperty("build.args.ARG1", "VAL1");
        }
    });

    test("Both workspaceFolder and workspaceMount must be set/unset", () => {
        const jsondata = {
            name: "devc",
            build: {
                dockerfile: "ubuntu",
                args: {
                    ARG1: "VAL1",
                },
            },
        };

        {
            const o = parser.ConfigSchema.safeParse(jsondata);
            expect(o.success).toBe(true);
        }
        {
            const o = parser.ConfigSchema.safeParse({
                ...jsondata,
                workspaceFolder: "a",
                workspaceMount: "source=b,target=c",
            });
            expect(o.success).toBe(true);
        }
        {
            const jsondata1 = { ...jsondata, workspaceFolder: "a" };
            const jsondata2 = { ...jsondata, workspaceMount: "source=/b,target=/b" };
            const o1 = parser.ConfigSchema.safeParse(jsondata1);
            const o2 = parser.ConfigSchema.safeParse(jsondata2);
            expect(o1.success).toBe(false);
            expect(o2.success).toBe(false);
            expect(o1.error?.message.search("must be [un]+set")).greaterThan(0);
            expect(o2.error?.message.search("must be [un]+set")).greaterThan(0);
        }
    });

    test("Extract remote workspace mount dest from workspaceMount", () => {
        {
            // restricting it to just one is handled in the parser
            const mounts = [
                { test: "source=/foo,target=/bar", result: "/bar" },
                { test: "source=/dir1/foo,target=/dir2/bar,type=bind", result: "/dir2/bar" },
                { test: "source=/dir1/foo,target=/dir3/bar/baz,consistency=cached,foo=bar", result: "/dir3/bar/baz" },
                { test: "source=/home/用户/项目,target=/workspace/проект,type=bind", result: "/workspace/проект" },
                { test: "source=/home/用户/项目,target=/workspace/проект/target,type=bind", result: "/workspace/проект/target" },

            ];

            for (const mount of mounts) {
                expect(parser.extractWorkspaceMount(mount.test)).contains(mount.result);
            }
        }
    });

    test("Reject missing target in workspaceMount", () => {
        const data = {
            name: "foo",
            image: "ubuntu",
            workspaceMount: 'source="/dir1/foo,tgt=bar',
        };

        const res = parser.ConfigSchema.safeParse(data);
        expect(res.success).toBe(false);
        expect(res.error?.message.search("not detect a 'target=...' mount")).greaterThan(0);
    });

    test("Reject multiple target matches in workspaceMount", () => {
        {
            const jsonbase = { name: "foo", image: "ubuntu", workspaceFolder: "/foo" };
            const jsondatas = [
                { ...jsonbase, workspaceMount: "source=/foo,target=/bar,target=/fooo" },
                { ...jsonbase, workspaceMount: 'source="/dir1/foo,target=bar",target=/dir2/bar,type=bind' },
                // { ...jsonbase, "workspaceMount": 'source=/dir1/foo,target=/dir3/bar/target,consistency=cached,foo=bar' },
                { ...jsonbase, workspaceMount: "source=/home/用户/target=项目,target=/workspace,target=проект,type=bind" },
            ];

            for (const data of jsondatas) {
                const res = parser.ConfigSchema.safeParse(data);
                expect(res.success).toBe(false);
                expect(res.error?.message.search("multiple mount targets")).greaterThan(0);
            }
        }
    });

    test("Image or dockerfile must be present", () => {
        {
            const jsondata = {
                name: "devc",
            };

            const o = parser.ConfigSchema.safeParse(jsondata);
            expect(o.success).toBe(false);
        }
    });

    test("both image and build/dockerFile must not be present", () => {
        const jsondata1 = {
            name: "devc",
            image: "ubuntu:24.04",
            build: {
                dockerfile: "dockerfile",
            },
        };

        const jsondata2 = {
            name: "devc",
            image: "ubuntu:24.04",
            dockerFile: "dockerfile",
        };

        const o1 = parser.ConfigSchema.safeParse(jsondata1);
        expect(o1.success).toBe(false);

        const o2 = parser.ConfigSchema.safeParse(jsondata2);
        expect(o2.success).toBe(false);
    });

    test("unknown fields are silently ignored", () => {
        const cfg = {
            image: "ubuntu",
            features: { "ghcr.io/devcontainers/features/node:1": {} },
            customizations: { vscode: { extensions: ["ms-python.python"] } },
        };
        const result = parser.ConfigSchema.safeParse(cfg);
        expect(result.success).toBe(true);
    });

    test("remoteEnv accepts null values for unsetting", () => {
        const cfg = {
            image: "ubuntu",
            remoteEnv: { SET_THIS: "value", UNSET_THIS: null },
        };
        const result = parser.ConfigSchema.safeParse(cfg);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.remoteEnv).toStrictEqual({ SET_THIS: "value", UNSET_THIS: null });
        }
    });

    test("remoteEnv rejects non-string non-null values", () => {
        const cfg = {
            image: "ubuntu",
            remoteEnv: { BAD: 123 },
        };
        const result = parser.ConfigSchema.safeParse(cfg);
        expect(result.success).toBe(false);
    });

    test("lifecycle command forms", () => {
        const lifecycleFields = [
            "initializeCommand",
            "onCreateCommand",
            "updateContentCommand",
            "postCreateCommand",
            "postStartCommand",
            "postAttachCommand",
        ] as const;

        for (const field of lifecycleFields) {
            const asString = { image: "ubuntu", [field]: "echo hello" };
            const asArray = { image: "ubuntu", [field]: ["echo", "hello"] };
            const asRecord = { image: "ubuntu", [field]: { cmd1: "echo hello", cmd2: ["a", "b"] } };

            if (field === "initializeCommand") {
                expect(parser.ConfigSchema.safeParse(asRecord).success, `${field} as record`).toBe(false);
                expect(parser.ConfigSchema.safeParse(asString).success, `${field} as string`).toBe(true);
                expect(parser.ConfigSchema.safeParse(asArray).success, `${field} as array`).toBe(true);
            }
            else {
                expect(parser.ConfigSchema.safeParse(asString).success, `${field} as string`).toBe(true);
                expect(parser.ConfigSchema.safeParse(asArray).success, `${field} as array`).toBe(true);
                expect(parser.ConfigSchema.safeParse(asRecord).success, `${field} as record`).toBe(true);
            }
        }
    });

    test("customizations.vscode.extensions is parsed", () => {
        const cfg = {
            image: "ubuntu",
            customizations: {
                vscode: {
                    extensions: ["llvm-vs-code-extensions.vscode-clangd", "jeanp413.open-remote-ssh"],
                },
            },
        };
        const result = parser.ConfigSchema.safeParse(cfg);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.customizations?.vscode?.extensions).toStrictEqual([
                "llvm-vs-code-extensions.vscode-clangd",
                "jeanp413.open-remote-ssh",
            ]);
        }
    });

    test("customizations without extensions is valid", () => {
        const cfg = {
            image: "ubuntu",
            customizations: { vscode: {} },
        };
        const result = parser.ConfigSchema.safeParse(cfg);
        expect(result.success).toBe(true);
    });

    test("spec defaults: image config", () => {
        const result = parser.ConfigSchema.parse({ image: "ubuntu" });

        expect(result.overrideCommand).toBe(true);
        expect(result.shutdownAction).toBe("stopContainer");
        expect(result.updateRemoteUserUID).toBe(true);
        expect(result.userEnvProbe).toBe("loginInteractiveShell");
        expect(result.init).toBe(false);
        expect(result.privileged).toBe(false);
        expect(result.capAdd).toStrictEqual([]);
        expect(result.securityOpt).toStrictEqual([]);
        expect(result.runArgs).toStrictEqual([]);
        expect(result.forwardPorts).toStrictEqual([]);
    });

    test("spec defaults: dockerfile config", () => {
        const result = parser.ConfigSchema.parse({
            build: { dockerfile: "Dockerfile" },
        });

        expect(result.overrideCommand).toBe(true);
        expect(result.shutdownAction).toBe("stopContainer");
        expect(result.updateRemoteUserUID).toBe(true);
        expect(result.userEnvProbe).toBe("loginInteractiveShell");
        expect(result.init).toBe(false);
        expect(result.privileged).toBe(false);
        expect(result.capAdd).toStrictEqual([]);
        expect(result.securityOpt).toStrictEqual([]);
        expect(result.runArgs).toStrictEqual([]);
        expect(result.forwardPorts).toStrictEqual([]);

        assert.ok(parser.isDockerfileBased(result));
        expect(result.build.context).toBe(".");
        expect(result.build.options).toStrictEqual([]);
    });
});
