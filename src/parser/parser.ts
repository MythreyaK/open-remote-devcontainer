import * as vscode from "vscode";
import * as jc from "jsonc-parser";

import * as schema from "./schema";
import { ParseError } from "../extension/error";

export async function parseDevcontainerFile(fspath: string): Promise<schema.Config> {
    const file = await (async () => {
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fspath));
            return new TextDecoder("utf-8").decode(bytes);
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
