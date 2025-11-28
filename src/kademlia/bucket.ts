// src/kademlia/bucket.ts
// Kademlia DHT K-bucket implementation as a binary tree.
//
// Based on k-bucket by Tristan Slominski (MIT License)
// https://github.com/tristanls/k-bucket

import { EventEmitter } from 'eventemitter3'
import { equalsBytes, randomBytes } from '../utils'
import type { Contact, KBucketEvent, KBucketOptions, PeerInfo } from './types.ts'

function createNode(): KBucketNode {
  return { contacts: [], noSplit: false, left: null, right: null }
}

type KBucketNode = {
  contacts: Contact[] | null
  noSplit: boolean
  left: KBucketNode | null
  right: KBucketNode | null
}

/**
 * Implementation of a Kademlia DHT k-bucket used for storing
 * contact (peer node) information.
 */
export class KBucket {
  public events: EventEmitter<KBucketEvent>
  protected _localNodeId: Uint8Array
  protected _numberOfNodesPerKBucket: number
  protected _numberOfNodesToPing: number
  public distance: (firstId: Uint8Array, secondId: Uint8Array) => number
  public arbiter: (incumbent: Contact, candidate: Contact) => Contact
  protected _metadata: object
  protected _root: KBucketNode

  constructor(options: KBucketOptions = {}) {
    this.events = new EventEmitter<KBucketEvent>()
    this._localNodeId = options.localNodeId ?? randomBytes(20)
    this._numberOfNodesPerKBucket = options.numberOfNodesPerKBucket ?? 16
    this._numberOfNodesToPing = options.numberOfNodesToPing ?? 6
    this.distance = options.distance ?? KBucket.distance
    this.arbiter = options.arbiter ?? KBucket.arbiter
    this._metadata = Object.assign({}, options.metadata)

    this._root = createNode()
  }

  /**
   * Get the local node ID.
   */
  get localNodeId(): Uint8Array {
    return this._localNodeId
  }

  /**
   * Default arbiter function for contacts with the same id. Uses
   * contact.vectorClock to select which contact to update the k-bucket with.
   * Contact with larger vectorClock field will be selected. If vectorClock is
   * the same, candidate will be selected.
   */
  static arbiter(incumbent: Contact, candidate: Contact): Contact {
    return incumbent.vectorClock > candidate.vectorClock ? incumbent : candidate
  }

  /**
   * Default distance function. Finds the XOR
   * distance between firstId and secondId.
   */
  static distance(firstId: Uint8Array, secondId: Uint8Array): number {
    let distance = 0
    let i = 0
    const min = Math.min(firstId.length, secondId.length)
    const max = Math.max(firstId.length, secondId.length)
    for (; i < min; ++i) {
      distance = distance * 256 + (firstId[i] ^ secondId[i])
    }
    for (; i < max; ++i) {
      distance = distance * 256 + 255
    }
    return distance
	}

	/**
   * Helper to get lookup keys from various peer identifier formats.
   */
  static getKeys(obj: Uint8Array | string | PeerInfo): string[] {
    if (obj instanceof Uint8Array) return [bytesToUnprefixedHex(obj)]
    if (typeof obj === 'string') return [obj]

    const keys: string[] = []
    if (obj.id instanceof Uint8Array) keys.push(bytesToUnprefixedHex(obj.id))
    if (obj.address !== undefined && typeof obj.tcpPort === 'number')
      keys.push(`${obj.address}:${obj.tcpPort}`)
    return keys
  }

  /**
   * Adds a contact to the k-bucket.
   */
  add(contact: PeerInfo): KBucket {
    if (!(contact.id instanceof Uint8Array)) {
      throw new Error('Contact must have an id')
    }

    let bitIndex = 0
    let node = this._root

    while (node.contacts === null) {
      node = this._determineNode(node, contact.id, bitIndex++)
    }

    // check if the contact already exists
    const index = this._indexOf(node, contact.id)
    if (index >= 0) {
      this._update(node, index, contact as Contact)
      return this
    }

    if (node.contacts.length < this._numberOfNodesPerKBucket) {
      node.contacts.push(contact as Contact)
      this.events.emit('added', contact)
      return this
    }

    // the bucket is full
    if (node.noSplit) {
      // we are not allowed to split the bucket
      // we need to ping the first this._numberOfNodesToPing
      // in order to determine if they are alive
      this.events.emit('ping', node.contacts.slice(0, this._numberOfNodesToPing), contact)
      return this
    }

    this._split(node, bitIndex)
    return this.add(contact)
	}

	/**
   * Get the n closest contacts to the provided node id.
   */
  closest(id: Uint8Array, n: number = Infinity): Contact[] {
    if (!(id instanceof Uint8Array)) {
      throw new TypeError('id must be a Uint8Array')
    }

    if ((!Number.isInteger(n) && n !== Infinity) || n <= 0) {
      throw new TypeError('n is not positive number')
    }

    let contacts: Contact[] = []

    for (let nodes = [this._root], bitIndex = 0; nodes.length > 0 && contacts.length < n; ) {
      const node = nodes.pop()!
      if (node.contacts === null) {
        const detNode = this._determineNode(node, id, bitIndex++)
        nodes.push(node.left === detNode ? node.right! : node.left!)
        nodes.push(detNode)
      } else {
        contacts = contacts.concat(node.contacts)
      }
    }

    // Sort the contacts by distance from node id and return `n` closest ones
    return contacts.sort((a, b) => this.distance(a.id, id) - this.distance(b.id, id)).slice(0, n)
	}

	/**
   * Counts the total number of contacts in the tree.
   */
  count(): number {
    let count = 0
    for (const nodes = [this._root]; nodes.length > 0; ) {
      const node = nodes.pop()!
      if (node.contacts === null) nodes.push(node.right!, node.left!)
      else count += node.contacts.length
    }
    return count
  }

  /**
   * Determines whether the id at the bitIndex is 0 or 1.
   * Return left leaf if `id` at `bitIndex` is 0, right leaf otherwise.
   */
  _determineNode(node: KBucketNode, id: Uint8Array, bitIndex: number): KBucketNode {
    const bytesDescribedByBitIndex = bitIndex >> 3
    const bitIndexWithinByte = bitIndex % 8
    if (id.length <= bytesDescribedByBitIndex && bitIndexWithinByte !== 0) {
      return node.left!
    }

    const byteUnderConsideration = id[bytesDescribedByBitIndex]

    if (byteUnderConsideration & (1 << (7 - bitIndexWithinByte))) {
      return node.right!
    }

    return node.left!
  }

  /**
   * Get a contact by its exact ID.
   */
  get(id: Uint8Array): Contact | null {
    let bitIndex = 0
    let node = this._root

    while (node.contacts === null) {
      node = this._determineNode(node, id, bitIndex++)
    }

    const index = this._indexOf(node, id)
    return index >= 0 ? node.contacts[index] : null
  }

  /**
   * Returns the index of the contact with provided id if it exists.
   */
  _indexOf(node: KBucketNode, id: Uint8Array): number {
    for (let i = 0; i < node.contacts!.length; ++i) {
      if (equalsBytes(node.contacts![i].id, id)) return i
    }
    return -1
  }

  /**
   * Removes contact with the provided id.
   */
  remove(id: Uint8Array): KBucket {
    let bitIndex = 0
    let node = this._root

    while (node.contacts === null) {
      node = this._determineNode(node, id, bitIndex++)
    }

    const index = this._indexOf(node, id)
    if (index >= 0) {
      const contact = node.contacts.splice(index, 1)[0]
      this.events.emit('removed', contact)
    }

    return this
  }

  /**
   * Splits the node, redistributes contacts to the new nodes.
   */
  _split(node: KBucketNode, bitIndex: number): void {
    node.left = createNode()
    node.right = createNode()

    // redistribute existing contacts amongst the two newly created nodes
    for (const contact of node.contacts!) {
      this._determineNode(node, contact.id, bitIndex).contacts!.push(contact)
    }

    node.contacts = null // mark as inner tree node

    // don't split the "far away" node
    const detNode = this._determineNode(node, this._localNodeId, bitIndex)
    const otherNode = node.left === detNode ? node.right : node.left
    otherNode.noSplit = true
  }

  /**
   * Returns all the contacts contained in the tree as an array.
   * Optimized to avoid array concatenation overhead.
   */
  toArray(): Contact[] {
    const result: Contact[] = []
    const stack: KBucketNode[] = [this._root]
    
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.contacts === null) {
        // Internal node - add children to stack
        if (node.right) stack.push(node.right)
        if (node.left) stack.push(node.left)
      } else {
        // Leaf node - push all contacts (reference, not clone)
        result.push(...node.contacts)
      }
    }
    return result
  }

  /**
   * Iterator for all contacts in the tree.
   */
  *toIterable(): Iterable<Contact> {
    for (const nodes = [this._root]; nodes.length > 0; ) {
      const node = nodes.pop()!
      if (node.contacts === null) {
        nodes.push(node.right!, node.left!)
      } else {
        yield* node.contacts
      }
    }
  }

  /**
   * Updates the contact selected by the arbiter.
   */
  _update(node: KBucketNode, index: number, contact: Contact): void {
    if (!equalsBytes(node.contacts![index].id, contact.id)) {
      throw new Error('wrong index for _update')
    }

    if (node.contacts === null) throw new Error('Missing node.contacts')

    const incumbent = node.contacts[index]
    const selection = this.arbiter(incumbent, contact)
    
    if (selection === incumbent && incumbent !== contact) return

    node.contacts.splice(index, 1)
    node.contacts.push(selection)
    this.events.emit('updated', incumbent, selection)
  }

  /**
   * Get detailed bucket structure information including splits and peers in each bucket.
   * Returns an array of bucket information sorted by bit depth.
   * @param includePeers - If false, peers array will be empty (faster for large networks)
   */
  getBucketStructure(includePeers = true): Array<{
    bitDepth: number
    bucketIndex: number
    bucketPath: string
    peerCount: number
    peers: Contact[]
    canSplit: boolean
    maxSize: number
  }> {
    const buckets: Array<{
      bitDepth: number
      bucketIndex: number
      bucketPath: string
      peerCount: number
      peers: Contact[]
      canSplit: boolean
      maxSize: number
    }> = []

    let globalIndex = 0

    const walkTree = (
      node: KBucketNode,
      bitDepth: number,
      path: string,
    ): void => {
      if (node.contacts === null) {
        // Internal node - recurse into left and right children
        walkTree(node.left!, bitDepth + 1, path + '0')
        walkTree(node.right!, bitDepth + 1, path + '1')
      } else {
        // Leaf node - this is an actual bucket
        buckets.push({
          bitDepth,
          bucketIndex: globalIndex++,
          bucketPath: path || '0', // Empty path for root bucket
          peerCount: node.contacts.length,
          peers: includePeers ? [...node.contacts] : [], // Only clone if needed
          canSplit: !node.noSplit,
          maxSize: this._numberOfNodesPerKBucket,
        })
      }
    }

    walkTree(this._root, 0, '')

    // Sort by bit depth, then by bucket path
    buckets.sort((a, b) => {
      if (a.bitDepth !== b.bitDepth) {
        return a.bitDepth - b.bitDepth
      }
      return a.bucketPath.localeCompare(b.bucketPath)
    })

    return buckets
  }

  /**
   * Get a summary of bucket splits showing how many buckets exist at each depth level.
   * This is optimized and doesn't clone peer data.
   */
  getBucketSplitSummary(): {
    totalBuckets: number
    maxDepth: number
    bucketsByDepth: Array<{ depth: number; count: number; totalPeers: number }>
  } {
    // Use lightweight walk that doesn't clone peers
    const bucketsByDepth = new Map<number, { count: number; totalPeers: number }>()
    let totalBuckets = 0
    let maxDepth = 0

    const walkTree = (
      node: KBucketNode,
      bitDepth: number,
    ): void => {
      if (node.contacts === null) {
        // Internal node - recurse into left and right children
        walkTree(node.left!, bitDepth + 1)
        walkTree(node.right!, bitDepth + 1)
      } else {
        // Leaf node - this is an actual bucket
        totalBuckets++
        if (bitDepth > maxDepth) maxDepth = bitDepth

        const existing = bucketsByDepth.get(bitDepth) ?? { count: 0, totalPeers: 0 }
        bucketsByDepth.set(bitDepth, {
          count: existing.count + 1,
          totalPeers: existing.totalPeers + (node.contacts?.length ?? 0),
        })
      }
    }

    walkTree(this._root, 0)

    return {
      totalBuckets,
      maxDepth,
      bucketsByDepth: Array.from(bucketsByDepth.entries())
        .map(([depth, info]) => ({
          depth,
          count: info.count,
          totalPeers: info.totalPeers,
        }))
        .sort((a, b) => a.depth - b.depth),
    }
  }
}

// Import for the helper
import { bytesToUnprefixedHex } from '../utils'
