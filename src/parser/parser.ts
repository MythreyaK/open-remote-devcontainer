import * as vscode from "vscode";
import * as jc from "jsonc-parser";

import * as schema from "./schema";
import { ParseError } from "../extension/error";

/* eslint-disable @typescript-eslint/unified-signatures */
export async function parseDevcontainer(fpath: vscode.Uri): Promise<schema.Config>;
export async function parseDevcontainer(contents: string): Promise<schema.Config>;
export async function parseDevcontainer(arg: string | vscode.Uri): Promise<schema.Config> {
    if (typeof arg === "string") {
        const parseInfo = schema.ConfigSchema.safeParse(jc.parse(arg));
        if (parseInfo.success) {
            return parseInfo.data;
        }
        else {
            throw new ParseError(`Parse error: ${parseInfo.error}`);
        }
    }
    else {
        const contents: string = await (async () => {
            try {
                const bytes = await vscode.workspace.fs.readFile(arg);
                return new TextDecoder("utf-8").decode(bytes);
            }
            catch (e) {
                throw new ParseError(`Could not read devcontainer.json file at ${arg.toString(true)}: ${JSON.stringify(e)}`);
            };
        })();

        return parseDevcontainer(contents);
    }
}
/* eslint-enable @typescript-eslint/unified-signatures */
