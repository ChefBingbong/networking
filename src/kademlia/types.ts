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
