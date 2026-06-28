import * as jc from "jsonc-parser";
import { readFileSync } from "node:fs";

import * as schema from "./schema";
import { ParseError } from "../extension/error";

export function parseDevcontainerFile(fspath: string): schema.Config {
    const file = (() => {
        try {
            return readFileSync(fspath, { encoding: "utf-8", flag: "r" });
        }
        catch (e) {
            throw new ParseError(`Could not read devcontainer.json file at ${fspath}: ${JSON.stringify(e)}`);
        };
    })();

    const parseInfo = schema.ConfigSchema.safeParse(jc.parse(file));
    if (parseInfo.success) {
        return parseInfo.data;
    }
    else {
        throw new ParseError(`Parse error: ${parseInfo.error}`);
    }
}
