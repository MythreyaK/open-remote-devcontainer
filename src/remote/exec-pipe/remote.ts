import net from "net";
import fs from "fs";

export const FrameType = {
    Ready: 0,
    Open: 1,
    Data: 2,
    Close: 3,
    LAST: 4,
    MAX: 15,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/**
 * remote.ts: container-side socket, shuttles data to the
 * local.ts on the host via docker exec stdin/stdout
 *
 * All types are exported here and used in local.ts to make
 * remote.ts standalone enough that it can be passed to node -e
 * without extra setup. We could compile this, embed into the
 * extension and send it in, but for transparency and quick
 * debugging, it's easier to keep the .ts file. Also makes
 * it easier to monkey-patch in the wild for quick-fixes.
 *
 * Format is simple: [ type(2B), channel(4B), length(4B) ]
 */

export const TYPE_SIZE = 2;
export const CHAN_SIZE = 4;
export const LEN_SIZE = 4;
export const HEADER_SIZE = TYPE_SIZE + CHAN_SIZE + LEN_SIZE;

export const TYPE_OFFSET = 0;
export const CHANNEL_OFFSET = TYPE_OFFSET + TYPE_SIZE;
export const LENGTH_OFFSET = CHANNEL_OFFSET + CHAN_SIZE;

function parseArgs(argv: string[]): { sock: string, disableNodeSafety: boolean } {
    let sock = "";
    let disableNodeSafety = false;
    for (const arg of argv) {
        if (arg.startsWith("--sock-path=")) { sock = arg.slice("--sock-path=".length); }
        else if (arg === "--disable-node-safety") { disableNodeSafety = true; }
    }
    return { sock, disableNodeSafety };
}

export function main() {
    const args = parseArgs(process.argv.slice(1));
    if (!args.sock) {
        console.error("[ssh-agent-relay/container]: --sock-path=<path> is required");
        process.exit(1);
    }
    const SOCK = args.sock;

    // stderr for all logs because stdio/stdout are for the data
    const log = (msg: string) => { console.error(`[ssh-agent-relay/container]: ${msg}`); };

    function cleanupSocket() {
        try {
            if (SOCK.startsWith("/tmp/")) {
                fs.unlinkSync(SOCK);
            }
            else {
                log(`[ERROR]: SOCK not in /tmp/, refusing to unlink ${SOCK}`);
            }
        }
        catch { }
    }

    function acquireSocket() {
        const dir = SOCK.substring(0, SOCK.lastIndexOf("/"));
        try { fs.mkdirSync(dir, { recursive: true }); }
        catch { }

        try {
            if (SOCK.startsWith("/tmp/")) {
                fs.unlinkSync(SOCK);
            }
            else {
                log(`[ERROR]: SOCK not in /tmp/, refusing to unlink ${SOCK}`);
            }
        }
        catch { }
    }

    let nextChan = 0;
    const clients = new Map<number, net.Socket>();

    function writeFrame(type: FrameType, chan: number, data: Buffer | null) {
        const header = Buffer.alloc(HEADER_SIZE);
        header.writeUInt16BE(type, TYPE_OFFSET);
        header.writeUInt32BE(chan, CHANNEL_OFFSET);
        header.writeUInt32BE(data ? data.length : 0, LENGTH_OFFSET);
        process.stdout.write(header);
        if (data && data.length > 0) { process.stdout.write(data); }
    }

    function closeClient(chan: number) {
        writeFrame(FrameType.Close, chan, null);
        clients.delete(chan);
    }

    let buf = Buffer.alloc(0);

    process.stdin.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);

        while (buf.length >= HEADER_SIZE) {
            const type: FrameType = buf.readUInt16BE(TYPE_OFFSET) as FrameType;
            if (type >= FrameType.LAST) {
                log(`[ERROR]: invalid frame type ${type}, dropping buffer`);
                buf = Buffer.alloc(0);
                break;
            }

            const chan = buf.readUInt32BE(CHANNEL_OFFSET);
            const len = buf.readUInt32BE(LENGTH_OFFSET);
            if (buf.length < HEADER_SIZE + len) { break; }

            const payload = len > 0 ? Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + len)) : null;
            buf = buf.subarray(HEADER_SIZE + len);

            const sock = clients.get(chan);
            if (!sock) {
                log(`[ERROR]: stdin: ch${chan} type=${type}: unknown channel, skipping frame`);
                continue;
            }

            if (type === FrameType.Data && payload) {
                log(`stdin->sock: ch${chan} ${payload.length}B`);
                sock.write(payload);
            }
            else if (type === FrameType.Close) {
                log(`stdin: ch${chan} Close`);
                sock.destroy();
                clients.delete(chan);
            }
        }
    });


    const serverOpts = args.disableNodeSafety ? { allowHalfOpen: true } : {};
    const server = net.createServer(serverOpts, (sock) => {
        const chan = nextChan++;

        clients.set(chan, sock);
        log(`client connected: ch${chan} (active: ${clients.size})`);

        writeFrame(FrameType.Open, chan, null);

        sock.on("data", (d) => {
            log(`sock->stdout: ch${chan} ${d.length}B`);
            writeFrame(FrameType.Data, chan, d);
        });
        sock.on("end", () => {
            log(`client disconnected: ch${chan} (active: ${clients.size - 1})`);
            closeClient(chan);
        });
        sock.on("error", (err) => {
            log(`[ERROR]: client [error]: ch${chan} ${(err as NodeJS.ErrnoException).code ?? err}`);
            closeClient(chan);
        });
    });

    process.on("SIGTERM", () => {
        log("SIGTERM received, shutting down");
        server.close();
        for (const [, s] of clients) { s.destroy(); }
        cleanupSocket();
        process.exit(0);
    });

    process.stdin.on("end", () => {
        log(`stdin closed, shutting down (active clients: ${clients.size})`);
        server.close();
        for (const [, s] of clients) { s.destroy(); }
        cleanupSocket();
        process.exit(0);
    });

    acquireSocket();
    server.listen(SOCK, () => {
        try { fs.chmodSync(SOCK, 0o600); }
        catch { }

        // TODO: symlink agent.sock to the latest working socket?

        log(`listening on ${SOCK}`);
        writeFrame(FrameType.Ready, 0, null);
    });
}
