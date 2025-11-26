// src/kademlia/ban-list.ts
// LRU-based ban list for misbehaving peers

import debugDefault from 'debug'
import { LRUCache } from 'lru-cache'
import { getPeerKeys, type PeerInfo } from './types.ts'

const debug = debugDefault('kad:ban-list')

export class BanList {
  private _lru: LRUCache<string, boolean>
  private DEBUG: boolean

  constructor(maxSize = 10000) {
    this._lru = new LRUCache({ max: maxSize })
    this.DEBUG =
      typeof globalThis.window === 'undefined' ? (process?.env?.DEBUG?.includes('ethjs') ?? false) : false
  }

  /**
   * Add a peer to the ban list.
   * @param obj Peer identifier (id bytes, hex string, or PeerInfo)
   * @param maxAge Optional TTL in ms for the ban
   */
  add(obj: string | Uint8Array | PeerInfo, maxAge?: number): void {
    for (const key of getPeerKeys(obj)) {
      this._lru.set(key, true, { ttl: maxAge })
      if (this.DEBUG) {
        const shortKey = key.length > 14 ? `${key.substring(0, 7)}...` : key
        debug(`Added peer ${shortKey}, size: ${this._lru.size}`)
      }
    }
  }

  /**
   * Check if a peer is banned.
   */
  has(obj: string | Uint8Array | PeerInfo): boolean {
    return getPeerKeys(obj).some((key: string) => Boolean(this._lru.get(key)))
  }

  /**
   * Remove a peer from the ban list.
   */
  remove(obj: string | Uint8Array | PeerInfo): void {
    for (const key of getPeerKeys(obj)) {
      this._lru.delete(key)
    }
  }

  /**
   * Get current ban list size.
   */
  get size(): number {
    return this._lru.size
  }

  /**
   * Clear all bans.
   */
  clear(): void {
    this._lru.clear()
  }
}

