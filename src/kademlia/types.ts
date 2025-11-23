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

export type StoredValueOrigin = "publisher" | "cache";

export type StoredValue = {
	value: unknown;
	storedAt: number;
	origin: StoredValueOrigin;
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
	lastSeen?: number;
	/**
	 * Last observed RTT to this contact in milliseconds.
	 * Used for simple clustering / proximity heuristics.
	 */
	lastRttMs?: number;
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
	  }
	/**
	 * DSHT (Coral-style sloppy hash table) RPCs.
	 * We store *pointers* to resources rather than raw content.
	 */
	| {
			type: "DSHT_PUT";
			from: NodeId;
			level: number; // cluster level
			key: Key;
			pointer: DshtPointer;
	  }
	| {
			type: "DSHT_PUT_RESULT";
			from: NodeId;
			level: number;
			key: Key;
			ok: boolean;
			reason?: "full" | "duplicate" | "error";
	  }
	| {
			type: "DSHT_GET";
			from: NodeId;
			level: number;
			key: Key;
			limit?: number;
	  }
	| {
			type: "DSHT_GET_RESULT";
			from: NodeId;
			level: number;
			key: Key;
			pointers: DshtPointer[];
	  };

/**
 * Pointer to a resource in the DSHT.
 * In Coral terminology this is a "replica pointer".
 * See: Freedman & Mazières, “Sloppy hashing and self-organizing clusters”
 * (`https://www.cs.princeton.edu/~mfreed/docs/coral-iptps03.pdf`).
 */
export interface DshtPointer {
	nodeId: NodeId;
	addr: string;
	// Arbitrary metadata about the object being pointed to (e.g. URL, hash, size).
	metadata?: Record<string, unknown>;
}

export interface DshtClusterLevelConfig {
	/**
	 * Cluster level index (0 = smallest / closest).
	 */
	level: number;
	/**
	 * Human-friendly name, e.g. "local", "region", "global".
	 */
	name: string;
	/**
	 * Target maximum RTT within this cluster, in milliseconds.
	 * This loosely corresponds to cluster diameter in Coral.
	 */
	maxRttMs: number;
	/**
	 * Maximum number of pointers we will store for a single key
	 * on a single node *at this level*.
	 */
	maxPointersPerKey: number;
}

export interface DshtConfig {
	levels: DshtClusterLevelConfig[];
}

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
