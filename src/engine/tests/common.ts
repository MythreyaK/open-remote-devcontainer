import path from "node:path";

import * as schema from "../../parser/schema";
import { expect } from "vitest";

export function withDefaults(cfg: { image: string, [k: string]: unknown }): schema.ImageDevcontainer;
export function withDefaults(cfg: { build: object, [k: string]: unknown }): schema.DockerfileDevcontainer;
export function withDefaults(cfg: Record<string, unknown>) {
    return schema.ConfigSchemaBase.parse(cfg);
}

export function sanityCheck(_lsf: string, _cfg: string) {
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
