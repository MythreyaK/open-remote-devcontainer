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
            expect(p.success);

            if (!p.success) {
                throw new Error("Expected parse to work");
            }

            const o = p.data;
            assert.strictEqual(o.type, "bind");
            assert.strictEqual(o.source, "/home/username/dir");
            assert.strictEqual(o.target, "/workspace/dir");
            assert.strictEqual(o.options, "ro,z");
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
            assert.strictEqual(o.type, "volume");
            assert.strictEqual(o.source, undefined);
            assert.strictEqual(o.target, "/workspace/dir");
            assert.strictEqual(o.options, "ro");
        }
        {
            const jsondata = {
                type: "somethingelse",
                target: "/workspace/dir",
                options: "ro",
            };

            const p = parser.Mount_z.safeParse(jsondata);
            expect(!p.success);
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

    test("Reject multiple target matches in workspaceMount", () => {
        {
            const jsonbase = { name: "foo", image: "ubuntu", workspaceFolder: "/foo" };
            const jsondatas = [
                { ...jsonbase, workspaceMount: "source=/foo,target=/bar,target" },
                { ...jsonbase, workspaceMount: 'source="/dir1/foo,target",target=/dir2/bar,type=bind' },
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
});
