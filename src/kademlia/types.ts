// src/kademlia/types.ts
// Types for Ethereum-compatible Kademlia DHT discovery protocol

import type { EventEmitter } from "eventemitter3";
import type { Common } from "../chain-config";

// ---------- Peer identification ----------

/**
 * Basic peer information used in discovery.
 * id is a 64-byte public key (without 0x04 prefix).
 */
export interface PeerInfo {
	id?: Uint8Array;
	address?: string;
	udpPort?: number | null;
	tcpPort?: number | null;
	vectorClock?: number;
}

/**
 * A confirmed contact with required id and vectorClock for k-bucket ordering.
 */
export interface Contact extends PeerInfo {
	id: Uint8Array;
	vectorClock: number;
}

// ---------- K-Bucket types ----------

export interface KBucketOptions {
	/**
	 * Local node id (64 bytes, public key without prefix).
	 * If not provided, a random id will be generated.
	 */
	localNodeId?: Uint8Array;
	/**
	 * Maximum nodes per k-bucket before splitting/pinging.
	 * Default: 16
	 */
	numberOfNodesPerKBucket?: number;
	/**
	 * Number of nodes to ping when a non-splittable bucket is full.
	 * Default: 3
	 */
	numberOfNodesToPing?: number;
	/**
	 * Custom XOR distance function.
	 */
	distance?: (firstId: Uint8Array, secondId: Uint8Array) => number;
	/**
	 * Arbiter function for contact updates with same id.
	 * Default: uses vectorClock comparison.
	 */
	arbiter?: (incumbent: Contact, candidate: Contact) => Contact;
	/**
	 * Optional metadata for the k-bucket.
	 */
	metadata?: object;
}

export interface KBucketEvent {
	ping: [contacts: Contact[], contact: PeerInfo];
	updated: [incumbent: Contact, selection: Contact];
	added: [peer: PeerInfo];
	removed: [peer: PeerInfo];
}

// ---------- Transport types ----------

export interface KademliaTransportOptions {
	/**
	 * Timeout for peer requests in ms.
	 * Default: 4000
	 */
	timeout?: number;
	/**
	 * Local endpoint info to include in messages.
	 * Default: 127.0.0.1, null ports
	 */
	endpoint?: PeerInfo;
	/**
	 * Custom socket creation function.
	 * Default: dgram.createSocket('udp4')
	 */
	createSocket?: Function;
	/**
	 * Common instance for crypto primitives.
	 */
	common?: Common;
}

export interface KademliaTransportEvent {
	listening: undefined;
	close: undefined;
	error: [error: Error];
	peers: [peers: PeerInfo[]];
	findneighbours: [{ peer: PeerInfo; targetId: Uint8Array }];
}

/**
 * Abstract transport interface for sending/receiving discovery messages.
 */
export interface KademliaTransport {
	bind(...args: any[]): void;
	destroy(...args: any[]): void;
	ping(peer: PeerInfo): Promise<PeerInfo>;
	findneighbours(peer: PeerInfo, id: Uint8Array): void;
	sendNeighbours?(peer: PeerInfo, neighbours: PeerInfo[]): void;
	events: EventEmitter<KademliaTransportEvent>;
}

// ---------- Kademlia Node types ----------

export interface KademliaConfig {
	/**
	 * Timeout for peer requests in ms.
	 * Default: 4000
	 */
	timeout?: number;
	/**
	 * Local endpoint info.
	 * Default: 127.0.0.1, null ports
	 */
	endpoint?: PeerInfo;
	/**
	 * Custom socket creation function.
	 */
	createSocket?: Function;
	/**
	 * Interval for peer table refresh in ms.
	 * Default: 60000
	 */
	refreshInterval?: number;
	/**
	 * Whether to query peers with findNeighbours for discovery.
	 * Default: true
	 */
	shouldFindNeighbours?: boolean;
	/**
	 * Only send/respond to findNeighbours from confirmed peers.
	 * Default: false
	 */
	onlyConfirmed?: boolean;
	/**
	 * K-bucket size (max nodes per bucket).
	 * Default: 16
	 */
	k?: number;
	/**
	 * Number of nodes to ping on bucket full.
	 * Default: 3
	 */
	concurrency?: number;
	/**
	 * Common instance for crypto primitives.
	 */
	common?: Common;
}

export interface KademliaEvent {
	listening: undefined;
	close: undefined;
	error: [error: Error];
	"peer:added": [peer: PeerInfo];
	"peer:new": [peer: PeerInfo];
	"peer:removed": [peer: PeerInfo];
}

// ---------- Routing table types ----------

export interface RoutingTableConfig {
	/**
	 * K-bucket size.
	 * Default: 16
	 */
	k?: number;
	/**
	 * Number of nodes to ping when bucket is full.
	 * Default: 3
	 */
	concurrency?: number;
}

export interface RoutingTableDump {
	localId: string;
	totalPeers: number;
	bucketCount: number;
}

// ---------- Utility types ----------

/**
 * Deferred promise helper for request/response correlation.
 */
export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: any) => void;
}

export function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T | PromiseLike<T>) => void = () => {};
	let reject: (reason?: any) => void = () => {};

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

// ---------- Protocol version ----------

export const DISCOVERY_VERSION = 0x04;

// ---------- Legacy compatibility types (for gradual migration) ----------

/**
 * @deprecated Use PeerInfo instead
 */
export type KadNodeInfo = PeerInfo;

/**
 * Helper to get lookup keys from various peer identifier formats.
 */
export function getPeerKeys(obj: string | Uint8Array | PeerInfo): string[] {
	if (obj instanceof Uint8Array) {
		return [bytesToUnprefixedHex(obj)];
	}
	if (typeof obj === "string") {
		return [obj];
	}

	const keys: string[] = [];
	if (obj.id instanceof Uint8Array) {
		keys.push(bytesToUnprefixedHex(obj.id));
	}
	if (obj.address !== undefined && typeof obj.tcpPort === "number") {
		keys.push(`${obj.address}:${obj.tcpPort}`);
	}
	return keys;
}

// Import for the helper above
import { bytesToUnprefixedHex } from "../utils";
