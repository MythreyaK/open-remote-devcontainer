import { describe, expect, test } from 'vitest';
import * as assert from 'assert';

import * as parser from '../schema';
// import { z } from 'zod/mini';

describe("Parser tests", () => {

    test("Parse mounts", () => {
        {
            const jsondata = {
                "type": "bind",
                "source": "/home/username/dir",
                "target": "/workspace/dir",
                "options": "ro,z"
            };

            const p = parser.Mount.safeParse(jsondata);
            expect(p.success);

            if (!p.success) { throw new Error("Expected parse to work"); }

            const o = p.data;
            assert.strictEqual(o.type, "bind");
            assert.strictEqual(o.source, "/home/username/dir");
            assert.strictEqual(o.target, "/workspace/dir");
            assert.strictEqual(o.options, "ro,z");
        }
        {
            const jsondata = {
                "type": "volume",
                "target": "/workspace/dir",
                "options": "ro"
            };

            const p = parser.Mount.safeParse(jsondata);
            if (!p.success) { throw new Error("Expected parse to work"); }

            const o = p.data;
            assert.strictEqual(o.type, "volume");
            assert.strictEqual(o.source, undefined);
            assert.strictEqual(o.target, "/workspace/dir");
            assert.strictEqual(o.options, "ro");
        }
        {
            const jsondata = {
                "type": "somethingelse",
                "target": "/workspace/dir",
                "options": "ro"
            };

            const p = parser.Mount.safeParse(jsondata);
            expect(!p.success);
        }
    });

    test("Parse both build syntax", () => {
        {
            const jsondata = {
                "name": "devc",
                "build": {
                    "dockerfile": "ubuntu",
                    "context": "dir",
                    "args": {
                        "ARG1": "VAL1"
                    },
                }
            };

            const o = parser.ConfigSchema.parse(jsondata);

            expect(o).toHaveProperty("name", "devc");
            expect(o).toHaveProperty("build.dockerfile", "ubuntu");
            expect(o).toHaveProperty("build.context", "dir");
            expect(o).toHaveProperty("build.args.ARG1", "VAL1");
        }
        {
            const jsondata = {
                "name": "devc",
                "dockerFile": "ubuntu",
                "context": "dir",
                "build": {
                    "args": {
                        "ARG1": "VAL1"
                    },
                }
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
            "name": "devc",
            "build": {
                "dockerfile": "ubuntu",
                "args": {
                    "ARG1": "VAL1"
                },
            }
        };

        {
            const o = parser.ConfigSchema.safeParse(jsondata);
            expect(o.success).toBe(true);
        }
        {
            const o = parser.ConfigSchema.safeParse({
                ...jsondata,
                "workspaceFolder": "a",
                "workspaceMount": "b",
            });
            expect(o.success).toBe(true);
        }
        {
            const jsondata1 = { ...jsondata, "workspaceFolder": "a" };
            const jsondata2 = { ...jsondata, "workspaceMount": "b" };
            const o1 = parser.ConfigSchema.safeParse(jsondata1);
            const o2 = parser.ConfigSchema.safeParse(jsondata2);
            expect(o1.success).toBe(false);
            expect(o2.success).toBe(false);
            expect(o1.error?.message.search("must be [un]+set")).greaterThan(0);
            expect(o2.error?.message.search("must be [un]+set")).greaterThan(0);
        }
    });

});
