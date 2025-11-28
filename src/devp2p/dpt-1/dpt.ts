// src/devp2p/dpt/dpt.ts
// DPT (Discovery Protocol) - Thin wrapper around Kademlia with DNS discovery support

import { EventEmitter } from 'eventemitter3'
import {
    KademliaNode,
    type KademliaNodeConfig,
    type PeerInfo,
} from '../../kademlia/index.ts'
import { DNS } from '../dns/index.ts'
import type { DPTEvent, DPTOptions } from '../types.ts'

/**
 * DPT (Discovery Protocol) for Ethereum peer discovery.
 * 
 * This is a thin wrapper around the KademliaNode that adds:
 * - DNS-based peer discovery (EIP-1459)
 * - Backward-compatible API with the original DPT implementation
 */
export class DPT {
  public events: EventEmitter<DPTEvent>
  public readonly id: Uint8Array | undefined

  protected _kad: KademliaNode
  protected _dns: DNS
  protected _shouldGetDnsPeers: boolean
  protected _dnsRefreshQuantity: number
  protected _dnsNetworks: string[]
  protected _dnsAddr: string
  protected _refreshIntervalId?: NodeJS.Timeout
  protected _privateKey: Uint8Array

  constructor(privateKey: Uint8Array, options: DPTOptions = {}) {
    this.events = new EventEmitter<DPTEvent>()
    this._privateKey = privateKey

    // DNS configuration
    this._shouldGetDnsPeers = options.shouldGetDnsPeers ?? false
    this._dnsRefreshQuantity = Math.floor((options.dnsRefreshQuantity ?? 25) / 2)
    this._dnsNetworks = options.dnsNetworks ?? []
    this._dnsAddr = options.dnsAddr ?? '8.8.8.8'

    // Initialize DNS
    this._dns = new DNS({ 
      dnsServerAddress: this._dnsAddr, 
      common: options.common 
    })

    // Create Kademlia node with options
    const kadOptions: KademliaNodeConfig = {
      timeout: options.timeout,
      endpoint: options.endpoint,
      createSocket: options.createSocket,
      refreshInterval: options.refreshInterval,
      shouldFindNeighbours: options.shouldFindNeighbours,
      onlyConfirmed: options.onlyConfirmed,
      common: options.common,
    }

    this._kad = new KademliaNode(privateKey, kadOptions)
    this.id = this._kad.id

    // Forward Kademlia events
    this._kad.events.on('listening', () => this.events.emit('listening', undefined))
    this._kad.events.on('close', () => this.events.emit('close', undefined))
    this._kad.events.on('error', (err) => this.events.emit('error', err))
    this._kad.events.on('peer:added', (peer) => this.events.emit('peer:added', peer))
    this._kad.events.on('peer:new', (peer) => this.events.emit('peer:new', peer))
    this._kad.events.on('peer:removed', (peer) => this.events.emit('peer:removed', peer))

    // Set up DNS refresh if enabled
    if (this._shouldGetDnsPeers) {
      const refreshInterval = Math.floor((options.refreshInterval ?? 60000) / 10)
      this._refreshIntervalId = setInterval(() => this._refreshDns(), refreshInterval)
    }
  }

  /**
   * Bind the UDP socket to start listening.
   */
  bind(...args: any[]): void {
    this._kad.bind(...args)
  }

  /**
   * Stop the DPT and clean up resources.
   */
  destroy(...args: any[]): void {
    if (this._refreshIntervalId) {
      clearInterval(this._refreshIntervalId)
      this._refreshIntervalId = undefined
    }
    this._kad.destroy(...args)
  }

  /**
   * Bootstrap the node by connecting to a known peer.
   */
  async bootstrap(peer: PeerInfo): Promise<void> {
    await this._kad.bootstrap(peer)
  }

  /**
   * Add a peer to the routing table after verifying it's alive.
   */
  async addPeer(obj: PeerInfo): Promise<PeerInfo> {
    return this._kad.addPeer(obj)
  }

  /**
   * Mark a peer as confirmed (for selective findNeighbours).
   * @param id Unprefixed hex id
   */
  confirmPeer(id: string): void {
    this._kad.confirmPeer(id)
  }

  /**
   * Get a peer by id, hex string, or PeerInfo.
   */
  getPeer(obj: string | Uint8Array | PeerInfo): PeerInfo | null {
    return this._kad.getPeer(obj)
  }

  /**
   * Get all peers in the routing table.
   */
  getPeers(): PeerInfo[] {
    return this._kad.getPeers()
  }

  /**
   * Get the number of peers in the routing table.
   */
  numPeers(): number {
    return this._kad.numPeers()
  }

  /**
   * Get the closest peers to a given id.
   */
  getClosestPeers(id: Uint8Array): PeerInfo[] {
    return this._kad.getClosestPeers(id)
  }

  /**
   * Remove a peer from the routing table.
   */
  removePeer(obj: string | PeerInfo | Uint8Array): void {
    this._kad.removePeer(obj)
  }

  /**
   * Ban a peer and remove from routing table.
   */
  banPeer(obj: string | PeerInfo | Uint8Array, maxAge?: number): void {
    this._kad.banPeer(obj, maxAge)
  }

  /**
   * Get peers from DNS discovery.
   */
  async getDnsPeers(): Promise<PeerInfo[]> {
    return this._dns.getPeers(this._dnsRefreshQuantity, this._dnsNetworks)
  }

  /**
   * Refresh the routing table.
   * Called automatically at refresh interval.
   */
  async refresh(): Promise<void> {
    await this._kad.refresh()
    await this._refreshDns()
  }

  /**
   * Refresh DNS peers if enabled.
   */
  private async _refreshDns(): Promise<void> {
    if (!this._shouldGetDnsPeers) return

    try {
      const dnsPeers = await this.getDnsPeers()
      this._addPeerBatch(dnsPeers)
    } catch {
      // Ignore DNS errors
    }
  }

  /**
   * Add peers with staggered timing.
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
   * Get the underlying Kademlia node.
   */
  get kademlia(): KademliaNode {
    return this._kad
  }

  /**
   * Get the DNS instance.
   */
  get dns(): DNS {
    return this._dns
  }
}
