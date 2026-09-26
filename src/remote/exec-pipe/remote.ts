import net from "net";
import fs from "fs";

export const FrameType = {
    Ready: 0,
    Open: 1,
    Data: 2,
    Close: 3,
    LAST: 15,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

// [ type(2B), channel(4B), length(4B) ]
export const TYPE_SIZE = 2;
export const CHAN_SIZE = 4;
export const LEN_SIZE = 4;
export const HEADER_SIZE = TYPE_SIZE + CHAN_SIZE + LEN_SIZE;

export const TYPE_OFFSET = 0;
export const CHANNEL_OFFSET = TYPE_OFFSET + TYPE_SIZE;
export const LENGTH_OFFSET = CHANNEL_OFFSET + CHAN_SIZE;

const SOCK = "${SSH_AGENT_SOCK_PATH}";
const EXTENSION_ID = "${EXTENSION_ID}";

export function main() {
    const TAG = `[${EXTENSION_ID}/bridge]`;
    const log = (msg: string) => { console.error(`${TAG} ${msg}`); };

    function cleanupSocket() {
        try { fs.unlinkSync(SOCK); }
        catch { }
    }

    function acquireSocket() {
        const dir = SOCK.substring(0, SOCK.lastIndexOf("/"));
        try { fs.mkdirSync(dir, { recursive: true }); }
        catch { }

        try { fs.unlinkSync(SOCK); }
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
            if (type > FrameType.LAST) {
                log(`invalid frame type ${type}, dropping buffer`);
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
                log(`stdin: ch${chan} type=${type} — unknown channel, skipping frame`);
                continue;
            }

            if (type === FrameType.Data && payload) {
                log(`stdin→sock: ch${chan} ${payload.length}B`);
                sock.write(payload);
            }
            else if (type === FrameType.Close) {
                log(`stdin: ch${chan} Close`);
                sock.destroy();
                clients.delete(chan);
            }
        }
    });

    const server = net.createServer((sock) => {
        const chan = nextChan++;
        clients.set(chan, sock);
        log(`client connected: ch${chan} (active: ${clients.size})`);
        writeFrame(FrameType.Open, chan, null);
        sock.on("data", (d) => {
            log(`sock→stdout: ch${chan} ${d.length}B`);
            writeFrame(FrameType.Data, chan, d);
        });
        sock.on("end", () => {
            log(`client disconnected: ch${chan} (active: ${clients.size - 1})`);
            closeClient(chan);
        });
        sock.on("error", (err) => {
            log(`client error: ch${chan} ${(err as NodeJS.ErrnoException).code ?? err}`);
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
