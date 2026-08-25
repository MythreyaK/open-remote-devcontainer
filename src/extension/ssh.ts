// These are copied and adapted from https://github.com/jeanp413/open-remote-ssh/
//
// https://github.com/jeanp413/open-remote-ssh/blob/41e50958631e8bb127d4786b65ba8e35e3fb1245/src/serverSetup.ts#L28-L75
// https://github.com/jeanp413/open-remote-ssh/blob/41e50958631e8bb127d4786b65ba8e35e3fb1245/src/ssh/sshDestination.ts
// https://github.com/jeanp413/open-remote-ssh/blob/41e50958631e8bb127d4786b65ba8e35e3fb1245/LICENSE.txt
//
// MIT License
//
// Copyright (c) 2022
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/* eslint-disable @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-assignment */
/**
 * Matches a hostname against a pattern that may contain wildcards.
 * Returns a specificity score: higher scores indicate more specific matches.
 * Returns -1 if no match.
 */
function matchHostnamePattern(hostname: string, pattern: string): number {
    // Exact match has highest priority
    if (hostname === pattern) {
        return 1000;
    }

    // Catch-all wildcard has lowest priority
    if (pattern === "*") {
        return 1;
    }

    // Convert wildcard pattern to regex
    // Escape special regex characters except *
    const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(hostname)) {
        // Calculate specificity based on the number of non-wildcard characters
        // More specific patterns (more characters) get higher scores
        const nonWildcardChars = pattern.replace(/\*/g, "").length;
        return 10 + nonWildcardChars;
    }

    return -1;
}

/**
 * Finds the best matching path for a hostname from a map of patterns to paths.
 * Supports wildcards with priority: exact match > specific wildcard > general wildcard.
 */
export function findSSHServerInstallPath(hostname: string, pathMap: Record<string, string>): string | undefined {
    let bestMatch: { pattern: string, path: string, score: number } | undefined;

    for (const [pattern, path] of Object.entries(pathMap)) {
        const score = matchHostnamePattern(hostname, pattern);

        if (score > 0) {
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { pattern, path, score };
            }
        }
    }

    return bestMatch?.path;
}

// MIT

export class SSHDestination {
    constructor(
        public readonly hostname: string,
        public readonly user?: string,
        public readonly port?: number,
    ) {
    }

    static parse(dest: string): SSHDestination {
        let user: string | undefined;
        const atPos = dest.lastIndexOf("@");
        if (atPos !== -1) {
            user = dest.substring(0, atPos);
        }

        let port: number | undefined;
        const colonPos = dest.lastIndexOf(":");
        if (colonPos !== -1) {
            port = parseInt(dest.substring(colonPos + 1), 10);
        }

        const start = atPos !== -1 ? atPos + 1 : 0;
        const end = colonPos !== -1 ? colonPos : dest.length;
        const hostname = dest.substring(start, end);

        return new SSHDestination(hostname, user, port);
    }

    toString(): string {
        let result = this.hostname;
        if (this.user) {
            result = `${this.user}@` + result;
        }
        if (this.port) {
            result = result + `:${this.port}`;
        }
        return result;
    }

    // vscode.uri implementation lowercases the authority, so when reopen or restore
    // a remote session from the recently openend list the connection fails
    static parseEncoded(dest: string): SSHDestination {
        try {
            const data = JSON.parse(Buffer.from(dest, "hex").toString());
            return new SSHDestination(data.hostName, data.user, data.port);
        }
        catch {
            // ignore
        }

        return SSHDestination.parse(dest.replace(/\\x([0-9a-f]{2})/g, (_, charCode) => String.fromCharCode(parseInt(charCode, 16))));
    }

    toEncodedString(): string {
        return this.toString().replace(/[A-Z]/g, ch => `\\x${ch.charCodeAt(0).toString(16).toLowerCase()}`);
    }
}
/* eslint-enable @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-assignment */
