import type { EventEmitter } from "node:events";
import type StrictEventEmitter from "strict-event-emitter-types";
import type { PeerInfo } from "./node";

export interface INetworkEvents {
	/**
	 * The least-recently connected enr that is currently considered disconnected and whose corresponding peer
	 * should be checked for connectivity in order to prevent it from being evicted.
	 *
	 * If connectivity to the peer is re-established the corresponding entry should be updated with EntryStatus.Connected
	 *
	 * If this entry's status is not updated after some timeout, it will be evicted
	 */
	//   connect: (enr: ENR) => void;
	/**
	 * The result of applying a pending node to a bucket, possibly (most likely) replacing an existing node
	 */
	disconnect: (ctx: PeerInfo) => void;
}

export type NetworkEventEmitter = StrictEventEmitter<
	EventEmitter,
	INetworkEvents
>;
