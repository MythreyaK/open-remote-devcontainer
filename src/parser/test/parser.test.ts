import {describe, expect, test} from 'vitest';
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

            const o = parser.Mount.parse(jsondata);

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

            const o = parser.Mount.parse(jsondata);

            assert.strictEqual(o.type, "volume");
            assert.strictEqual(o.source, undefined);
            assert.strictEqual(o.target, "/workspace/dir");
            assert.strictEqual(o.options, "ro");
        }
    });

    test("Parse both build syntax", () => {
        {
            const jsondata = {
                "name": "devc",
                "build": {
                    "dockerfile": "ubuntu",
                    "args": {
                        "ARG1": "VAL1"
                    },
                }
            };

            const o = parser.Config.parse(jsondata);

            expect(o).toHaveProperty("name", "devc");
            expect(o).toHaveProperty("build.dockerfile", "ubuntu");
            expect(o).toHaveProperty("build.args.ARG1", "VAL1");
        }
        {
            const jsondata = {
                "name": "devc",
                "dockerFile": "ubuntu",
                "build": {
                    "args": {
                        "ARG1": "VAL1"
                    },
                }
            };

            const o = parser.Config.parse(jsondata);

            expect(o).toHaveProperty("name", "devc");
            expect(o).toHaveProperty("dockerFile", "ubuntu");
            expect(o).toHaveProperty("build.args.ARG1", "VAL1");
        }

    });

});
