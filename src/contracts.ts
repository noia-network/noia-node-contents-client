import * as EventEmitter from "events";
import StrictEventEmitter from "strict-event-emitter-types";
import { ProtocolEvent, Response, Handshake } from "@noia-network/protocol";

export interface StorageStats {
    total: number;
    available: number;
    used: number;
}

export interface ContentTransfererEvents {
    response: (data: ProtocolEvent<Response>) => this;
    connected: (data: ProtocolEvent<Handshake>) => this;
}

export interface ContentTransferer extends StrictEventEmitter<EventEmitter, ContentTransfererEvents> {
    getExternalIp: () => string | undefined;
    connect: (address?: string) => Promise<void>;
    disconnect: () => Promise<void>;
    isConnected: () => boolean;
    requested: (missingPieces: number, infoHash: string) => void;
}
