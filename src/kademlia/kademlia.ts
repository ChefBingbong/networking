// src/kademlia/kademlia.ts
// Ethereum-compatible Kademlia DHT node for peer discovery

import { secp256k1 } from 'ethereum-cryptography/secp256k1.js'
import { EventEmitter } from 'eventemitter3'
import type { Common } from '../chain-config'
import { bytesToInt, bytesToUnprefixedHex, randomBytes } from '../utils'

import { BanList } from './ban-list.ts'
import { RoutingTable } from './routing-table.ts'
import {
	type KademliaConfig,
	type KademliaEvent,
	type KademliaTransport,
	type PeerInfo,
} from './types.ts'
import { UdpTransport } from './udp.ts'
import { pk2id } from './xor.ts'

const KBUCKET_SIZE = 16
const KBUCKET_CONCURRENCY = 3
const DEFAULT_REFRESH_INTERVAL = 60000 // 60 seconds

export interface KademliaNodeConfig extends KademliaConfig {
  /**
   * Custom transport implementation.
   * If not provided, UdpTransport will be created.
   */
  transport?: KademliaTransport
  port?: number
}

/**
 * Kademlia DHT node for Ethereum-compatible peer discovery.
 * Implements the discovery protocol (ping/pong/findneighbours/neighbours).
 */
export class KademliaNode {
  public events: EventEmitter<KademliaEvent>
  public readonly id: Uint8Array | undefined

  protected _privateKey: Uint8Array
  protected _banlist: BanList
  protected _kbucket: RoutingTable
  protected _transport: KademliaTransport
  protected _refreshIntervalId?: NodeJS.Timeout
  protected _refreshIntervalSelectionCounter: number = 0
  protected _shouldFindNeighbours: boolean
  protected _onlyConfirmed: boolean
  protected _confirmedPeers: Set<string> = new Set()
  protected _common?: Common
  protected _port: number

  private DEBUG: boolean

  constructor(privateKey: Uint8Array, options: KademliaNodeConfig = {}) {
    this.events = new EventEmitter<KademliaEvent>()
    this._privateKey = privateKey
    this.id = pk2id(secp256k1.getPublicKey(this._privateKey, false))

    this._shouldFindNeighbours = options.shouldFindNeighbours ?? true
    this._onlyConfirmed = options.onlyConfirmed ?? false
    this._common = options.common

    // Initialize ban list
    this._banlist = new BanList()
	this._port = options.endpoint?.udpPort ?? options.endpoint?.tcpPort ?? 0
    // Initialize routing table (k-bucket)
    this._kbucket = new RoutingTable(this.id, {
      k: options.k ?? KBUCKET_SIZE,
      concurrency: options.concurrency ?? KBUCKET_CONCURRENCY,
    })

    // Forward routing table events
    this._kbucket.events.on('added', (peer: PeerInfo) => {
      this.events.emit('peer:added', peer)
    })
    this._kbucket.events.on('removed', (peer: PeerInfo) => {
      this.events.emit('peer:removed', peer)
    })
    this._kbucket.events.on('ping', this._onKBucketPing.bind(this))

	
    // Initialize transport
    if (options.transport) {
      this._transport = options.transport
    } else {
      this._transport = new UdpTransport(
        privateKey,
        {
          timeout: options.timeout,
          endpoint: options.endpoint,
          createSocket: options.createSocket,
          common: options.common,
        },
        (peers) => this._onPeersDiscovered(peers),
        (id) => this.getPeer(id), // Provide getPeer callback for checking peer existence
      )
    }

    // Forward transport events
    this._transport.events.once('listening', () => this.events.emit('listening', undefined))
    this._transport.events.once('close', () => this.events.emit('close', undefined))
    this._transport.events.on('error', (err) => this.events.emit('error', err))
    
    // Handle peers discovered from neighbours responses
    this._transport.events.on('peers', (peers: PeerInfo[]) => {
      if (this._shouldFindNeighbours && Array.isArray(peers) && peers.length > 0) {
        this._addPeerBatch(peers)
      }
    })
    
    // Handle incoming findneighbours requests
    this._transport.events.on('findneighbours', ({ peer, targetId }: { peer: PeerInfo; targetId: Uint8Array }) => {
      if (!this.id) return
      
      // Get closest peers to the target ID (respects onlyConfirmed flag)
      const closestPeers = this.getClosestPeers(targetId)
      const k = options.k ?? KBUCKET_SIZE
      
      // Send neighbours response (limit to k peers as per Ethereum discovery)
      if (closestPeers.length > 0 && 'sendNeighbours' in this._transport) {
        this._transport.sendNeighbours(peer, closestPeers.slice(0, k))
      }
    })

    // Start refresh interval
    const refreshInterval = Math.floor((options.refreshInterval ?? DEFAULT_REFRESH_INTERVAL) / 10)
    this._refreshIntervalId = setInterval(() => this.refresh(), refreshInterval)

    this.DEBUG =false
  }

  /**
   * Bind the transport to a port and start listening.
   */
  bind(...args: any[]): void {
    this._transport.bind(...args)
  }

  /**
   * Stop the node and clean up resources.
   */
  destroy(...args: any[]): void {
    if (this._refreshIntervalId) {
      clearInterval(this._refreshIntervalId)
      this._refreshIntervalId = undefined
    }
    this._transport.destroy(...args)
  }

  /**
   * Handle k-bucket ping event (bucket full, need to verify old peers).
   */
  private _onKBucketPing(oldPeers: PeerInfo[], newPeer: PeerInfo): void {
    if (this._banlist.has(newPeer)) return

    let count = 0
    let err: Error | null = null

    for (const peer of oldPeers) {
      this._transport
        .ping(peer)
        .then(() => {
			if (++count < oldPeers.length) return
			if (err === null)
			  this._banlist.add(newPeer, 300000) // 5 min * 60 * 1000
			else this._kbucket.add(newPeer)
		  })
		  .catch((_err: Error) => {
			this._banlist.add(peer, 300000) // 5 min * 60 * 1000
			this._kbucket.remove(peer)
			err = err ?? _err
		  })
    }
  }

  /**
   * Called when peers are discovered via transport.
   */
  private _onPeersDiscovered(peers: PeerInfo[]): void {
    if (!this._shouldFindNeighbours) return
    this._addPeerBatch(peers)
  }

  /**
   * Add peers with staggered timing to avoid flooding.
   */
  private _addPeerBatch(peers: PeerInfo[]): void {
    const DIFF_TIME_MS = 200
    let ms = 0

    for (const peer of peers) {
      setTimeout(() => {
        this.addPeer(peer).catch((error) => {
          this.events.emit('error', error)
        })
      }, ms)
      ms += DIFF_TIME_MS
    }
  }

  /**
   * Bootstrap the node by connecting to a known peer.
   */
  async bootstrap(peer: PeerInfo): Promise<void> {
    try {
      const resolvedPeer = await this.addPeer(peer)
      if (resolvedPeer.id !== undefined) {
        this._confirmedPeers.add(bytesToUnprefixedHex(resolvedPeer.id))
      }
    } catch (error: any) {
      this.events.emit('error', error)
      return
    }

    if (!this.id) return

    if (this._shouldFindNeighbours) {
      this._transport.findneighbours(peer, this.id)
    }
  }

  /**
   * Add a peer to the routing table after verifying it's alive.
   */
  async addPeer(obj: PeerInfo): Promise<PeerInfo> {
    if (this._banlist.has(obj)) {
      throw new Error('Peer is banned')
    }

    // Check if already in routing table
    const existing = this._kbucket.get(obj)
    if (existing !== null) return existing

    // Verify peer is alive with ping
    try {
      const peer = await this._transport.ping(obj)
      this.events.emit('peer:new', peer)
      this._kbucket.add(peer)
      return peer
    } catch (err: any) {
      this._banlist.add(obj, 300000) // 5 minutes
      throw err
    }
  }

  /**
   * Mark a peer as confirmed (for selective findNeighbours).
   */
  confirmPeer(id: string): void {
    if (this._confirmedPeers.size < 5000) {
      this._confirmedPeers.add(id)
    }
  }

  /**
   * Get a peer by id, hex string, or PeerInfo.
   */
  getPeer(obj: string | Uint8Array | PeerInfo): PeerInfo | null {
    return this._kbucket.get(obj)
  }

  /**
   * Get all peers in the routing table.
   */
  getPeers(): PeerInfo[] {
    return this._kbucket.getAll()
  }

  /**
   * Get the number of peers in the routing table.
   */
  numPeers(): number {
    return this._kbucket.count()
  }

  /**
   * Get the closest peers to a given id.
   */
  getClosestPeers(id: Uint8Array): PeerInfo[] {
    let peers = this._kbucket.closest(id)
    if (this._onlyConfirmed && this._confirmedPeers.size > 0) {
      peers = peers.filter((peer) =>
        peer.id ? this._confirmedPeers.has(bytesToUnprefixedHex(peer.id)) : false,
      )
    }

    return peers
  }

  /**
   * Remove a peer from the routing table.
   */
  removePeer(obj: string | PeerInfo | Uint8Array): void {
    const peer = this._kbucket.get(obj)
    if (peer?.id !== undefined) {
      this._confirmedPeers.delete(bytesToUnprefixedHex(peer.id))
    }
    this._kbucket.remove(obj)
  }

  /**
   * Ban a peer and remove from routing table.
   */
  banPeer(obj: string | PeerInfo | Uint8Array, maxAge?: number): void {
    this._banlist.add(obj, maxAge)
    this._kbucket.remove(obj)
  }

  /**
   * Refresh the routing table by querying random peers.
   */
  async refresh(): Promise<void> {
    if (!this._shouldFindNeighbours) return

    // Rotating selection counter going in loop from 0..9
    this._refreshIntervalSelectionCounter = (this._refreshIntervalSelectionCounter + 1) % 10

    const peers = this.getPeers()

    for (const peer of peers) {
      // Randomly distributed selector based on peer ID
      const selector = bytesToInt((peer.id as Uint8Array).subarray(0, 1)) % 10
      
      let confirmed = true
      if (this._onlyConfirmed && this._confirmedPeers.size > 0) {
      const id = bytesToUnprefixedHex(peer.id as Uint8Array)
        if (!this._confirmedPeers.has(id)) {
          confirmed = false
        }
      }

      if (confirmed && selector === this._refreshIntervalSelectionCounter) {
          // Use a random target ID for refresh (or our own ID to refresh nearby buckets)
          const targetId = Math.random() > 0.5 ? this.id : randomBytes(64)
          this._transport.findneighbours(peer, targetId)
        }
    }
  }

  /**
   * Get the underlying transport.
   */
  get transport(): KademliaTransport {
    return this._transport
  }

  /**
   * Get the underlying routing table.
   */
  get routingTable(): RoutingTable {
    return this._kbucket
  }

  /**
   * Alias for routingTable (backward compatibility).
   */
  get table(): RoutingTable {
    return this._kbucket
  }

  /**
   * Get the ban list.
   */
  get banlist(): BanList {
    return this._banlist
  }

  /**
   * Check if a peer is banned.
   */
  isBanned(obj: string | Uint8Array | PeerInfo): boolean {
    return this._banlist.has(obj)
  }

  /**
   * Get detailed bucket structure including splits and peers in each bucket.
   */
  getBucketStructure(): Array<{
    bitDepth: number
    bucketIndex: number
    bucketPath: string
    peerCount: number
    peers: PeerInfo[]
    canSplit: boolean
    maxSize: number
  }> {
    return this._kbucket.getBucketStructure()
  }

  /**
   * Get a summary of bucket splits showing how many buckets exist at each depth level.
   */
  getBucketSplitSummary(): {
    totalBuckets: number
    maxDepth: number
    bucketsByDepth: Array<{ depth: number; count: number; totalPeers: number }>
  } {
    return this._kbucket.getBucketSplitSummary()
  }
}

// Factory function for creating a Kademlia node
export function createKademlia(
  privateKey: Uint8Array,
  options: KademliaNodeConfig = {},
): KademliaNode {
  return new KademliaNode(privateKey, options)
}

// Re-export for convenience
export { KademliaNode as Kademlia }
