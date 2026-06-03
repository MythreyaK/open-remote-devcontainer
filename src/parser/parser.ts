import { readFile } from 'node:fs/promises';
import * as jc from 'jsonc-parser';

import * as p from './schema';

class ParseError extends Error {
    constructor(
        public readonly reason: string
    ) {
        super(reason);
    }
};

export async function parseDevcontainerFile(fspath: string): Promise<p.Config> {
    const jsonContent = await readFile(fspath, {encoding: "utf-8", flag: "r"}).catch((e: unknown) => {
        throw new ParseError(`Could not read devcontainer.json file at ${fspath}: ${JSON.stringify(e)}`);
    });

    const parseInfo = p.Config.safeParse(jc.parse(jsonContent));

    if (parseInfo.success) {
        return parseInfo.data;
    }
    else {
        throw new ParseError(`Parse error: ${parseInfo.error}`);
    }
};
