// src/devp2p/dpt/index.ts
// DPT (Discovery Protocol) exports

export { DPT } from './dpt.ts'

// Re-export Kademlia types for backward compatibility
export {
    BanList, KademliaNode, type Contact, type KademliaConfig, type KademliaEvent, type PeerInfo
} from '../../kademlia/index.ts'

