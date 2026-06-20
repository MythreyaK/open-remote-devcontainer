import * as jc from "jsonc-parser";
import { readFileSync } from "node:fs";

import * as schema from "./schema";
import { ParseError } from "../extension/error";

export function parseDevcontainerFile(fspath: string): schema.Config {
    try {
        const jsonContent = readFileSync(fspath, { encoding: "utf-8", flag: "r" });
        const parseInfo = schema.ConfigSchema.safeParse(jc.parse(jsonContent));

        if (parseInfo.success) {
            return parseInfo.data;
        }
        else {
            throw new ParseError(`Parse error: ${parseInfo.error}`);
        }
    }
    catch (e) {
        throw new ParseError(`Could not read devcontainer.json file at ${fspath}: ${JSON.stringify(e)}`);
    };
};
