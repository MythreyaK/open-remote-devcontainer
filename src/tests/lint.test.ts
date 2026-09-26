import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SRC_DIR = resolve(__dirname, "..");
const OBJECT_DEFAULT_PATTERN = /\w+:\s*(\{[^}]+\}|[\w<>.\[\]]+)\s*=\s*\{[^}]+\}/;

function getSourceFiles(dir: string = SRC_DIR): string[] {
    const entries: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory() && entry !== "node_modules") {
            entries.push(...getSourceFiles(full));
        }
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
            entries.push(full);
        }
    }
    return entries;
}

describe("lint", () => {
    test("no object literal defaults in function parameters", () => {
        const violations: string[] = [];

        for (const file of getSourceFiles()) {
            const lines = readFileSync(file, "utf-8").split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (OBJECT_DEFAULT_PATTERN.test(lines[i])) {
                    const rel = file.replace(SRC_DIR + "/", "");
                    violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                }
            }
        }

        expect(violations, [
            "Use destructured defaults instead of object literal defaults:",
            "  Bad:  opts: Type = { key: val }",
            "  Good: { key = val }: Type = {}",
            "",
            ...violations,
        ].join("\n")).toHaveLength(0);
    });
});
