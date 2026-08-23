import * as vscode from "vscode";
import * as jc from "jsonc-parser";

import * as schema from "./schema";
import { ParseError } from "../extension/error";
import { getExecCtx } from "../common/ctx/ctx";
import { getLogSink } from "../extension/log";

/* eslint-disable @typescript-eslint/unified-signatures */
export async function parseDevcontainer(fpath: vscode.Uri): Promise<schema.Config>;
export async function parseDevcontainer(contents: string): Promise<schema.Config>;
export async function parseDevcontainer(arg: string | vscode.Uri): Promise<schema.Config> {
    if (typeof arg === "string") {
        getLogSink().debug(`parseDevcontainer(${arg.length}: string):`);
        const parseInfo = schema.ConfigSchema.safeParse(jc.parse(arg));
        if (parseInfo.success) {
            return parseInfo.data;
        }
        else {
            throw new ParseError(`Parse error: ${parseInfo.error}`);
        }
    }
    else {
        getLogSink().debug(`parseDevcontainer(${arg.toString(true)}: vscode.Uri):`);
        const contents: string = await (async () => {
            try {
                return await getExecCtx().fs.read(arg);
            }
            catch (e) {
                throw new ParseError(`Could not read devcontainer.json file at ${arg.toString(true)}: ${JSON.stringify(e)}`);
            };
        })();

        return parseDevcontainer(contents);
    }
}
/* eslint-enable @typescript-eslint/unified-signatures */
