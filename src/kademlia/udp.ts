// src/kademlia/udp.ts
// UDP transport for Ethereum-compatible Kademlia discovery protocol

import debugDefault from "debug";
import * as dgram from "dgram";
import { EventEmitter } from "eventemitter3";
import { LRUCache } from "lru-cache";
import type { Common } from "../chain-config";
import { bytesToHex, bytesToUnprefixedHex } from "../utils";

import {
	decode,
	type DecodedMessage,
	encode,
	type MessageTypeName,
} from "./message.ts";
import {
	createDeferred,
	type Deferred,
	DISCOVERY_VERSION,
	type KademliaTransport,
	type KademliaTransportEvent,
	type KademliaTransportOptions,
	type PeerInfo,
} from "./types.ts";
import { pk2id } from "./xor.ts";

const debug = debugDefault("kad:transport");
const verbose = debugDefault("verbose").enabled;

function formatLogId(id: string): string {
	return verbose ? id : id.substring(0, 7);
}

interface PendingRequest {
	peer: PeerInfo;
	deferred: Deferred<PeerInfo>;
	timeoutId: NodeJS.Timeout;
}

/**
 * UDP transport implementing the Ethereum discovery protocol.
 * Handles message encoding/signing and request/response correlation.
 */
export class UdpTransport implements KademliaTransport {
	public events: EventEmitter<KademliaTransportEvent>;

	private _privateKey: Uint8Array;
	private _timeout: number;
	private _endpoint: PeerInfo;
	private _requests: Map<string, PendingRequest> = new Map();
	private _requestsCache: LRUCache<string, Promise<PeerInfo>>;
	private _socket: dgram.Socket | null = null;
	private _common?: Common;
	private _onPeers?: (peers: PeerInfo[]) => void;
	private _getPeer?: (id: Uint8Array) => PeerInfo | null;

	private DEBUG: boolean;

	constructor(
		privateKey: Uint8Array,
		options: KademliaTransportOptions = {},
		onPeers?: (peers: PeerInfo[]) => void,
		getPeer?: (id: Uint8Array) => PeerInfo | null,
	) {
		this.events = new EventEmitter<KademliaTransportEvent>();
		this._privateKey = privateKey;
		this._timeout = options.timeout ?? 4000;
		this._endpoint = options.endpoint ?? {
			address: "127.0.0.1",
			udpPort: null,
			tcpPort: null,
		};
		this._requestsCache = new LRUCache({ max: 1000, ttl: 1000 });
		this._common = options.common;
		this._onPeers = onPeers;
		this._getPeer = getPeer;

		const createSocket =
			options.createSocket ?? (() => dgram.createSocket({ type: "udp4" }));
		this._socket = createSocket();

		if (this._socket) {
			this._socket.once("listening", () =>
				this.events.emit("listening", undefined),
			);
			this._socket.once("close", () => this.events.emit("close", undefined));
			this._socket.on("error", (err) => this.events.emit("error", err));
			this._socket.on("message", (msg: Uint8Array, rinfo: dgram.RemoteInfo) => {
				try {
					this._handleMessage(msg, rinfo);
				} catch (err: any) {
					this.events.emit("error", err);
				}
			});
		}

		this.DEBUG =
			typeof globalThis.window === "undefined"
				? (process?.env?.DEBUG?.includes("ethjs") ?? false)
				: false;
	}

	/**
	 * Bind the UDP socket to a port.
	 */
	bind(...args: any[]): void {
		this._isAliveCheck();
		if (this.DEBUG) {
			debug("call .bind");
		}
		this._socket?.bind(...args);
	}

	/**
	 * Close the UDP socket and clean up.
	 */
	destroy(...args: any[]): void {
		this._isAliveCheck();
		if (this.DEBUG) {
			debug("call .destroy");
		}

		// Clear all pending requests
		for (const [key, request] of this._requests) {
			clearTimeout(request.timeoutId);
			request.deferred.reject(new Error("Transport destroyed"));
			this._requests.delete(key);
		}

		if (this._socket) {
			this._socket.close(...args);
			this._socket = null;
		}
	}

	/**
	 * Ping a peer to verify it's alive.
	 * Returns the peer info with resolved ID on success.
	 */
	async ping(peer: PeerInfo): Promise<PeerInfo> {
		this._isAliveCheck();

		// Check cache for in-flight requests
		const rcKey = `${peer.address}:${peer.udpPort}`;
		const cached = this._requestsCache.get(rcKey);
		if (cached !== undefined) return cached;

		// Send ping message
		const hash = this._send(peer, "ping", {
			version: DISCOVERY_VERSION,
			from: this._endpoint,
			to: peer,
		});

		const deferred = createDeferred<PeerInfo>();
		const rKey = bytesToUnprefixedHex(hash);

		this._requests.set(rKey, {
			peer,
			deferred,
			timeoutId: setTimeout(() => {
				if (this._requests.has(rKey)) {
					if (this.DEBUG) {
						debug(
							`ping timeout: ${peer.address}:${peer.udpPort} ${
								peer.id ? formatLogId(bytesToHex(peer.id)) : "-"
							}`,
						);
					}
					this._requests.delete(rKey);
					deferred.reject(
						new Error(`Timeout error: ping ${peer.address}:${peer.udpPort}`),
					);
				}
			}, this._timeout),
		});

		this._requestsCache.set(rcKey, deferred.promise);
		return deferred.promise;
	}

	/**
	 * Send a findneighbours request (fire-and-forget).
	 * Response will come via 'peers' event.
	 */
	findneighbours(peer: PeerInfo, id: Uint8Array): void {
		this._isAliveCheck();
		this._send(peer, "findneighbours", { id });
	}

	/**
	 * Check if socket is still alive.
	 */
	private _isAliveCheck(): void {
		if (this._socket === null) throw new Error("Transport already destroyed");
	}

	/**
	 * Send a discovery message to a peer.
	 * Returns the message hash for request correlation.
	 */
	private _send(
		peer: PeerInfo,
		typename: MessageTypeName,
		data: any,
	): Uint8Array {
		if (this.DEBUG) {
			debug(
				`send ${typename} to ${peer.address}:${peer.udpPort} (peerId: ${
					peer.id ? formatLogId(bytesToHex(peer.id)) : "-"
				})`,
			);
		}

		const msg = encode(typename, data, this._privateKey, this._common);

		if (this._socket && typeof peer.udpPort === "number") {
			this._socket.send(msg, 0, msg.length, peer.udpPort, peer.address);
		}

		return msg.subarray(0, 32); // message hash
	}

	/**
	 * Handle incoming UDP message.
	 */
	private _handleMessage(msg: Uint8Array, rinfo: dgram.RemoteInfo): void {
		let decoded: DecodedMessage;
		try {
			decoded = decode(msg, this._common);
		} catch (err) {
			if (this.DEBUG) {
				debug(
					`failed to decode message from ${rinfo.address}:${rinfo.port}: ${err}`,
				);
			}
			return;
		}

		const { typename, data, publicKey } = decoded;
		const peerId = pk2id(publicKey);

		if (this.DEBUG) {
			debug(
				`received ${typename} from ${rinfo.address}:${rinfo.port} (peerId: ${formatLogId(
					bytesToHex(peerId),
				)})`,
			);
		}

		switch (typename) {
			case "ping": {
				// Respond with pong
				const remote: PeerInfo = {
					id: peerId,
					udpPort: rinfo.port,
					address: rinfo.address,
				};
				this._send(remote, "pong", {
					to: {
						address: rinfo.address,
						udpPort: rinfo.port,
						tcpPort: data.from.tcpPort,
					},
					hash: msg.subarray(0, 32),
				});

				// Notify about new peer if not already known
				// Only emit if peer is not already in the table (matches original behavior)
				if (data.from.udpPort !== null) {
					const existingPeer = this._getPeer?.(peerId);
					if (existingPeer === null) {
						setTimeout(() => {
							this._onPeers?.([data.from]);
							this.events.emit("peers", [data.from]); // Emit array of peers
						}, 100);
					}
				}
				break;
			}

			case "pong": {
				// Resolve pending ping request
				const rKey = bytesToUnprefixedHex(data.hash);
				const request = this._requests.get(rKey);
				if (request !== undefined) {
					clearTimeout(request.timeoutId);
					this._requests.delete(rKey);
					const resolvedPeer: PeerInfo = {
						id: peerId,
						address: request.peer.address,
						udpPort: request.peer.udpPort,
						tcpPort: request.peer.tcpPort,
					};
					request.deferred.resolve(resolvedPeer);
				}
				break;
			}

			case "findneighbours": {
				// Emit findneighbours event so KademliaNode can respond with neighbours
				const remote: PeerInfo = {
					id: peerId,
					udpPort: rinfo.port,
					address: rinfo.address,
				};
				// Emit event with the requesting peer and target ID
				this.events.emit("findneighbours", { peer: remote, targetId: data.id });
				break;
			}

			case "neighbours": {
				// Notify about discovered peers
				// data.peers is already an array of PeerInfo objects from decode
				const peers: PeerInfo[] = data.peers;
				this._onPeers?.(peers);
				this.events.emit("peers", peers); // Emit array of peers
				break;
			}
		}
	}

	/**
	 * Send a neighbours response to a peer.
	 * This is called by the KademliaNode when handling findneighbours.
	 */
	sendNeighbours(peer: PeerInfo, neighbours: PeerInfo[]): void {
		this._isAliveCheck();
		this._send(peer, "neighbours", { peers: neighbours });
	}

	/**
	 * Get the local endpoint configuration.
	 */
	get endpoint(): PeerInfo {
		return this._endpoint;
	}

	/**
	 * Update the local endpoint configuration.
	 */
	setEndpoint(endpoint: PeerInfo): void {
		this._endpoint = endpoint;
	}
}

// Export for backward compatibility
export { UdpTransport as UdpKademliaTransport };
