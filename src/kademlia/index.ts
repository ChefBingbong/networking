// src/kademlia/index.ts
// Ethereum-compatible Kademlia DHT for peer discovery

// Main exports
export { KademliaNode, Kademlia, createKademlia, type KademliaNodeConfig } from './kademlia.ts'
export { RoutingTable, type RoutingTableEvent } from './routing-table.ts'
export { KBucket } from './bucket.ts'
export { BanList } from './ban-list.ts'
export { UdpTransport, UdpKademliaTransport } from './udp.ts'

// Message encoding
export {
  encode,
  decode,
  MessageTypes,
  type DecodedMessage,
  type MessageTypeName,
  type PingData,
  type PongData,
  type FindNeighboursData,
  type NeighboursData,
} from './message.ts'

// XOR utilities
export {
  xor,
  xorDistance,
  xorDistanceBigInt,
  bucketIndex,
  bucketIndexFromDistance,
  hashToId,
  pk2id,
  id2pk,
  zfill,
  distance,
} from './xor.ts'

// Types
export {
  // Peer types
  type PeerInfo,
  type Contact,
  
  // Event types
  type KademliaEvent,
  type KBucketEvent,
  type KademliaTransportEvent,
  
  // Config types
  type KademliaConfig,
  type KBucketOptions,
  type KademliaTransportOptions,
  type RoutingTableConfig,
  type RoutingTableDump,
  
  // Transport interface
  type KademliaTransport,
  
  // Utilities
  type Deferred,
  createDeferred,
  getPeerKeys,
  
  // Constants
  DISCOVERY_VERSION,
} from './types.ts'

