// src/kademlia/routing-table.ts
// Wrapper around the tree-based KBucket with peer lookup helpers

import { EventEmitter } from 'eventemitter3'
import { bytesToUnprefixedHex } from '../utils'
import { KBucket } from './bucket.ts'
import type { Contact, KBucketEvent, PeerInfo, RoutingTableConfig } from './types.ts'

const KBUCKET_SIZE = 16
const KBUCKET_CONCURRENCY = 3

export interface RoutingTableEvent extends KBucketEvent {}

export class RoutingTable {
  public events: EventEmitter<RoutingTableEvent>
  protected _peers: Map<string, PeerInfo> = new Map()
  protected _kbucket: KBucket

  constructor(localNodeId: Uint8Array, config: RoutingTableConfig = {}) {
    this.events = new EventEmitter<RoutingTableEvent>()
    
    this._kbucket = new KBucket({
      localNodeId,
      numberOfNodesPerKBucket: config.k ?? KBUCKET_SIZE,
      numberOfNodesToPing: config.concurrency ?? KBUCKET_CONCURRENCY,
    })

    // Forward events from the underlying k-bucket
    this._kbucket.events.on('added', (peer: PeerInfo) => {
      for (const key of this.getKeys(peer)) {
        this._peers.set(key, peer)
      }
      this.events.emit('added', peer)
    })

    this._kbucket.events.on('removed', (peer: PeerInfo) => {
      for (const key of this.getKeys(peer)) {
        this._peers.delete(key)
      }
      this.events.emit('removed', peer)
    })

    this._kbucket.events.on('ping', (oldPeers: Contact[], newPeer: PeerInfo) => {
      this.events.emit('ping', oldPeers, newPeer)
    })

    this._kbucket.events.on('updated', (incumbent: Contact, selection: Contact) => {
      this.events.emit('updated', incumbent, selection)
    })
		}

  /**
   * Get the local node ID.
   */
  get localNodeId(): Uint8Array {
    return this._kbucket.localNodeId
		}

  /**
   * Get lookup keys from various peer identifier formats.
   */
  private getKeys(obj: Uint8Array | string | PeerInfo): string[] {
    if (obj instanceof Uint8Array) return [bytesToUnprefixedHex(obj)]
    if (typeof obj === 'string') return [obj]

    const keys: string[] = []
    if (obj.id instanceof Uint8Array) keys.push(bytesToUnprefixedHex(obj.id))
    if (obj.address !== undefined && typeof obj.tcpPort === 'number')
      keys.push(`${obj.address}:${obj.tcpPort}`)
    return keys
  }

  /**
   * Add a peer to the routing table.
   * Emits 'ping' event if bucket is full and needs verification.
   */
  add(peer: PeerInfo): void {
    const isExists = this.getKeys(peer).some((key) => this._peers.has(key))
    if (!isExists) {
      this._kbucket.add(peer)
    }
	}

	/**
   * Get a peer by id (Uint8Array), hex string, or PeerInfo.
	 */
  get(obj: Uint8Array | string | PeerInfo): PeerInfo | null {
    for (const key of this.getKeys(obj)) {
      const peer = this._peers.get(key)
      if (peer !== undefined) return peer
    }
    return null
  }

  /**
   * Get all peers in the routing table.
   */
  getAll(): PeerInfo[] {
    return this._kbucket.toArray()
  }

  /**
   * Get the n closest peers to the given id.
   */
  closest(id: Uint8Array, n: number = KBUCKET_SIZE): PeerInfo[] {
    return this._kbucket.closest(id, n)
  }

  /**
   * Remove a peer from the routing table.
   */
  remove(obj: Uint8Array | string | PeerInfo): void {
    const peer = this.get(obj)
    if (peer?.id !== undefined) {
      this._kbucket.remove(peer.id)
    }
  }

  /**
   * Check if a peer exists in the routing table.
   */
  has(obj: Uint8Array | string | PeerInfo): boolean {
    return this.get(obj) !== null
  }

  /**
   * Get the total number of peers.
   */
  count(): number {
    return this._kbucket.count()
  }

  /**
   * Get a dump of the routing table state for debugging.
   */
  dump(): { localId: string; totalPeers: number; bucketCount: number } {
		return {
      localId: bytesToUnprefixedHex(this._kbucket.localNodeId),
      totalPeers: this._kbucket.count(),
      bucketCount: this._peers.size,
    }
	}

  /**
   * Get all contacts (compatibility alias for getAll).
   */
  allContacts(): Contact[] {
    return this.getAll() as Contact[]
  }

  /**
   * Get total contact count (compatibility alias for count).
   */
  totalContactCount(): number {
    return this.count()
  }

  /**
   * Get non-empty bucket count.
   * Since we use a tree-based structure, return the total number of peers.
   */
  getNonEmptyBucketCount(): number {
    return this.count() > 0 ? 1 : 0
  }

  /**
   * Get detailed bucket structure including splits and peers in each bucket.
   * @param includePeers - If false, peers array will be empty (faster for large networks)
   */
  getBucketStructure(includePeers = true): Array<{
    bitDepth: number
    bucketIndex: number
    bucketPath: string
    peerCount: number
    peers: PeerInfo[]
    canSplit: boolean
    maxSize: number
  }> {
    const structure = this._kbucket.getBucketStructure(includePeers)
    
    if (!includePeers) {
      // Return structure without peer data
      return structure.map((bucket) => ({
        ...bucket,
        peers: [],
      }))
    }

    // Only map peers if includePeers is true
    return structure.map((bucket) => ({
      ...bucket,
      peers: bucket.peers.map(peer => ({
        id: peer.id,
        address: peer.address,
        udpPort: peer.udpPort,
        tcpPort: peer.tcpPort,
      })),
    }))
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
