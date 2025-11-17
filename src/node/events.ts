import type { EventEmitter } from "node:events";
import type StrictEventEmitter from "strict-event-emitter-types";
import type { PeerInfo } from "../session/nodeInfo";

export interface INetworkEvents {
	disconnect: (ctx: PeerInfo) => void;
	error: (err: Error) => void;
}

export type NetworkEventEmitter = StrictEventEmitter<
	EventEmitter,
	INetworkEvents
>;
