import * as WebSocket from "ws";
import * as http from "http";
import * as FSChunkStore from "fs-chunk-store";
import { Wire, Seed, ProtocolEvent, Requested, NodeMetadata, MasterMetadata } from "@noia-network/protocol";

const PIECE_LENGTH = 32768;
const DATA_LENGTH = 22610641;
const path = "NOIA_Network.mp4";
const DATA_METADATA: Seed = {
    metadata: {
        infoHash: "f8f40a6b918314b6ec7cb71d487aec1d529b163b",
        pieces: 691
    }
};
const MOCK_METADATA: NodeMetadata = {
    version: "1.0.0",
    walletAddress: "address",
    interface: "cli",
    connections: { webrtc: null, ws: 7676, wss: null },
    nodeId: "nodeId"
};

const store = FSChunkStore(PIECE_LENGTH, { path, length: DATA_LENGTH });
const server = http.createServer();
const wss = new WebSocket.Server({ server });
wss.on("connection", ws => {
    const wire = new Wire<NodeMetadata, MasterMetadata>(ws, MOCK_METADATA);
    wire.handshake().then(() => {
        wire.seed(DATA_METADATA);
        wire.on("requested", info => {
            handleMessage(wire, info);
        });
    });
});
server.listen(7777, "localhost", (err: Error) => {
    if (err) {
        throw err;
    }
    console.info("listening");
});

function handleMessage(wire: Wire<NodeMetadata, MasterMetadata>, params: ProtocolEvent<Requested>): void {
    const piece = params.data.piece;
    const infoHash = params.data.infoHash;
    if (typeof piece === "undefined") {
        const msg = `bad request infoHash=${infoHash} index=${piece}`;
        console.error(msg);
        throw msg;
    }
    store.get(piece, (err: Error, dataBuf: Buffer) => {
        if (err) {
            throw err;
        }
        console.info(`response infoHash=${infoHash} index=${piece} length=${dataBuf.length}`);
        const buf = responseBuffer(piece, infoHash, dataBuf);
        wire.response(buf);
    });

    function responseBuffer(part: number, hash: string, dataBuf: Buffer): Buffer {
        const partBuf = Buffer.allocUnsafe(4);
        partBuf.writeUInt32BE(part, 0);
        const infoHashBuf = Buffer.from(hash, "hex");
        const buf = Buffer.concat([partBuf, infoHashBuf, dataBuf]);
        return buf;
    }
}
