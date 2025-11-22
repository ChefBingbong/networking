// src/kademlia/types.ts
import type { EventEmitter } from "events";

/**
 * Status of a peer in the bucket.
 */
export enum EntryStatus {
	Disconnected = 0,
	Connected = 1,
}

/**
 * Result of updating an entry.
 */
export enum UpdateResult {
	Updated,
	NotModified,
	UpdatedPending,
	UpdatedAndPromoted,
	FailedKeyNonExistent,
	FailedBucketFull,
}

/**
 * Result of inserting / updating from the "public" API.
 */
export enum InsertResult {
	Inserted,
	Pending,
	Updated,
	UpdatedAndPromoted,
	ValueUpdated,
	StatusUpdated,
	StatusUpdatedAndPromoted,
	UpdatedPending,
	NodeExists,
	FailedBucketFull,
	FailedInvalidSelfUpdate,
}

/**
 * Basic bucket entry.
 */
export interface KadEntry {
	value: KadNodeInfo;
	status: EntryStatus;
}

/**
 * Bucket entry that may be pending.
 */
export interface KadEntryFull extends KadEntry {
	pending: boolean;
}

/**
 * Events emitted by Buckets / RoutingTable for eviction decisions, etc.
 */
export interface BucketEventEmitter extends EventEmitter {
	on(
		event: "pendingEviction",
		listener: (candidateToPing: KadNodeInfo) => void,
	): this;

	on(
		event: "appliedEviction",
		listener: (inserted: KadNodeInfo, evicted?: KadNodeInfo) => void,
	): this;
}

/**
 * What your HTTP API already returns.
 */
export type KadRoutingTableDump = {
	localId: string;
	totalPeers: number;
	nonEmptyBuckets: number;
	buckets: {
		index: number;
		size: number;
		peers: KadNodeInfo[];
	}[];
};
export const KADEMLIA_PROTOCOL = "/kad/1.0.0";

export interface KadNodeInfo {
	id: string;
	addr: string;
}
export interface KadBase {
	from: string;
	rpcId?: string;
}

export type KadMessage =
	| (KadBase & { type: "PING" })
	| (KadBase & { type: "PONG" })
	| (KadBase & { type: "FIND_NODE"; target: string })
	| (KadBase & { type: "NODES"; target: string; nodes: KadNodeInfo[] })
	| (KadBase & { type: "STORE"; key: string; value: any })
	| (KadBase & { type: "FIND_VALUE"; key: string })
	| (KadBase & { type: "VALUE"; key: string; value: any });

export interface KademliaConfig {
	k: number;
	alpha: number;
	maxBuckets: number;
	pendingTimeoutMs?: number;
}

export type StoredValue = {
	value: any;
	storedAt: number;
};

export type PendingRpc =
	| {
			type: "FIND_NODE";
			resolve: (nodes: KadNodeInfo[]) => void;
			timer: NodeJS.Timeout;
	  }
	| {
			type: "FIND_VALUE";
			resolve: (res: { value?: any; nodes?: KadNodeInfo[] }) => void;
			timer: NodeJS.Timeout;
	  }
	| {
			type: "PING";
			resolve: (ok: boolean) => void;
			timer: NodeJS.Timeout;
	  };

export type NodeId = string; // e.g. "a3f9..."

// For simplicity, keys also live in the same ID space.
// In a real system you’d hash the key into this space.
export type Key = string;

export interface Contact {
	id: NodeId;
	host: string;
	port: number;
	// You can replace this with Multiaddr or your own type.
	addr: string;
}

// kad-types.ts

/**
 * Basic Kad RPCs matching your KademliaNode.handleRpc logic.
 */
export type KadRpc =
	| { type: "PING"; from: NodeId }
	| { type: "PONG"; from: NodeId }
	| { type: "STORE"; from: NodeId; key: Key; value: any }
	| { type: "FIND_NODE"; from: NodeId; target: NodeId }
	| {
			type: "FIND_NODE_RESULT";
			from: NodeId;
			nodes: Contact[]; // contacts of other nodes
	  }
	| { type: "FIND_VALUE"; from: NodeId; key: Key }
	| {
			type: "FIND_VALUE_RESULT";
			from: NodeId;
			value?: any;
			nodes?: Contact[];
	  };

/**
 * The transport abstraction KademliaNode expects.
 * One call = one RPC round-trip.
 */
export interface KademliaTransport {
	/**
	 * Send one KadRpc to `to`, and resolve with the response KadRpc.
	 * Should reject on timeout or transport error.
	 */
	sendRpc(to: Contact, rpc: KadRpc): Promise<KadRpc>;
}
