// src/kademlia/message.ts
// RLP-encoded, secp256k1-signed message encoding for Ethereum-compatible discovery protocol

import debugDefault from 'debug'
import { keccak256 } from 'ethereum-cryptography/keccak.js'
import { secp256k1 } from 'ethereum-cryptography/secp256k1'
import { ecdsaRecover } from 'ethereum-cryptography/secp256k1-compat.js'
import * as RLP from '../rlp'
import {
    bigIntToBytes,
    bytesToHex,
    bytesToInt,
    bytesToUtf8,
    concatBytes,
    equalsBytes,
    intToBytes,
    setLengthLeft
} from '../utils'

import type { Common } from '../chain-config'
import type { PeerInfo } from './types.ts'

const debug = debugDefault('kad:message')

// ---------- Utility functions ----------

function getTimestamp() {
  return (Date.now() / 1000) | 0
}

export function assertEq(
  expected: Uint8Array | number | null,
  actual: Uint8Array | number | null,
  msg: string,
  debugFn: Function,
): void {
  if (expected instanceof Uint8Array && actual instanceof Uint8Array) {
    if (equalsBytes(expected, actual)) return
    const fullMsg = `${msg}: ${bytesToHex(expected)} / ${bytesToHex(actual)}`
    debugFn(`[ERROR] ${fullMsg}`)
    throw new Error(fullMsg)
  }

  if (expected === actual) return
  const fullMsg = `${msg}: ${expected} / ${actual}`
  debugFn(fullMsg)
  throw new Error(fullMsg)
}

export function unstrictDecode(value: Uint8Array) {
  // RLP library throws on remainder.length !== 0
  // This utility function bypasses that
  return RLP.decode(value, true).data
}

// ---------- IP address utilities ----------

const ipv4Regex = /^(\d{1,3}\.){3,3}\d{1,3}$/
const ipv6Regex = /^(::)?(((\d{1,3}\.){3}(\d{1,3}){1})?([0-9a-f]){0,4}:{0,2}){1,8}(::)?$/i

export function isV4Format(ip: string): boolean {
  return ipv4Regex.test(ip)
}

export function isV6Format(ip: string): boolean {
  return ipv6Regex.test(ip)
}

export function ipToString(bytes: Uint8Array, offset?: number, length?: number): string {
  offset = offset !== undefined ? ~~offset : 0
  length = length ?? bytes.length - offset

  const tempArray: Array<number | string> = []
  let result: string = ''
  if (length === 4) {
    // IPv4
    for (let i = 0; i < length; i++) {
      tempArray.push(bytes[offset + i])
    }
    result = tempArray.join('.')
  } else if (length === 16) {
    // IPv6
    for (let i = 0; i < length; i += 2) {
      tempArray.push(new DataView(bytes.buffer).getUint16(offset + i).toString(16))
    }
    result = tempArray.join(':')
    result = result.replace(/(^|:)0(:0)*:0(:|$)/, '$1::$3')
    result = result.replace(/:{3,4}/, '::')
  }

  return result
}

export function ipToBytes(ip: string, bytes?: Uint8Array, offset: number = 0): Uint8Array {
  offset = ~~offset

  let result: Uint8Array

  if (isV4Format(ip)) {
    result = bytes ?? new Uint8Array(offset + 4)
    ip.split(/\./g).map((byte) => {
      result[offset++] = parseInt(byte, 10) & 0xff
    })
  } else if (isV6Format(ip)) {
    const sections = ip.split(':', 8)

    let i
    for (i = 0; i < sections.length; i++) {
      const isv4 = isV4Format(sections[i])
      let v4Bytes: Uint8Array = new Uint8Array([])

      if (isv4) {
        v4Bytes = ipToBytes(sections[i])
        sections[i] = bytesToHex(v4Bytes.subarray(0, 2)).slice(2)
      }

      if (v4Bytes.length > 0 && ++i < 8) {
        sections.splice(i, 0, bytesToHex(v4Bytes.subarray(2, 4)).slice(2))
      }
    }

    if (sections[0] === '') {
      while (sections.length < 8) sections.unshift('0')
    } else if (sections[sections.length - 1] === '') {
      while (sections.length < 8) sections.push('0')
    } else if (sections.length < 8) {
      for (i = 0; i < sections.length && sections[i] !== ''; i++);
      const argv: any = [i, 1]
      for (i = 9 - sections.length; i > 0; i--) {
        argv.push('0')
      }
      sections.splice.apply(sections, argv)
    }

    result = bytes ?? new Uint8Array(offset + 16)
    for (i = 0; i < sections.length; i++) {
      const word = parseInt(sections[i], 16)
      result[offset++] = (word >> 8) & 0xff
      result[offset++] = word & 0xff
    }
  } else {
    throw Error(`Invalid ip format: ${ip}`)
  }

  if (result === undefined) {
    throw Error(`Invalid ip address: ${ip}`)
  }

  return result
}

// ---------- Message field encoders/decoders ----------

const timestamp = {
  encode(value = getTimestamp() + 60) {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value)
    return bytes
  },
  decode(bytes: Uint8Array) {
    if (bytes.length !== 4) throw new RangeError(`Invalid timestamp bytes: ${bytesToHex(bytes)}`)
    return new DataView(bytes.buffer).getUint32(0)
  },
}

const address = {
  encode(value: string) {
    if (isV4Format(value)) return ipToBytes(value)
    if (isV6Format(value)) return ipToBytes(value)
    throw new Error(`Invalid address: ${value}`)
  },
  decode(bytes: Uint8Array) {
    if (bytes.length === 4) return ipToString(bytes)
    if (bytes.length === 16) return ipToString(bytes)

    const str = bytesToUtf8(bytes)
    if (isV4Format(str) || isV6Format(str)) return str

    throw new Error(`Invalid address bytes: ${bytesToHex(bytes)}`)
  },
}

const port = {
  encode(value: number | null): Uint8Array {
    if (value === null) return new Uint8Array()
    if (value >>> 16 > 0) throw new RangeError(`Invalid port: ${value}`)
    return Uint8Array.from([(value >>> 8) & 0xff, (value >>> 0) & 0xff])
  },
  decode(bytes: Uint8Array): number | null {
    if (bytes.length === 0) return null
    return bytesToInt(bytes)
  },
}

const endpoint = {
  encode(obj: PeerInfo): Uint8Array[] {
    return [
      address.encode(obj.address!),
      port.encode(obj.udpPort ?? null),
      port.encode(obj.tcpPort ?? null),
    ]
  },
  decode(payload: Uint8Array[]): PeerInfo {
    return {
      address: address.decode(payload[0]),
      udpPort: port.decode(payload[1]),
      tcpPort: port.decode(payload[2]),
    }
  },
}

// ---------- Message type definitions ----------

type InPing = { [0]: Uint8Array; [1]: Uint8Array[]; [2]: Uint8Array[]; [3]: Uint8Array }
type OutPing = { version: number; from: PeerInfo; to: PeerInfo; timestamp?: number }

const ping = {
  encode(obj: OutPing): InPing {
    return [
      intToBytes(obj.version),
      endpoint.encode(obj.from),
      endpoint.encode(obj.to),
      timestamp.encode(obj.timestamp),
    ]
  },
  decode(payload: InPing): OutPing {
    return {
      version: bytesToInt(payload[0]),
      from: endpoint.decode(payload[1]),
      to: endpoint.decode(payload[2]),
      timestamp: timestamp.decode(payload[3]),
    }
  },
}

type OutPong = { to: PeerInfo; hash: Uint8Array; timestamp?: number }
type InPong = { [0]: Uint8Array[]; [1]: Uint8Array; [2]: Uint8Array }

const pong = {
  encode(obj: OutPong) {
    return [endpoint.encode(obj.to), obj.hash, timestamp.encode(obj.timestamp)]
  },
  decode(payload: InPong) {
    return {
      to: endpoint.decode(payload[0]),
      hash: payload[1],
      timestamp: timestamp.decode(payload[2]),
    }
  },
}

type OutFindNeighbours = { id: Uint8Array; timestamp?: number }
type InFindNeighbours = { [0]: Uint8Array; [1]: Uint8Array }

const findneighbours = {
  encode(obj: OutFindNeighbours): InFindNeighbours {
    return [obj.id, timestamp.encode(obj.timestamp)]
  },
  decode(payload: InFindNeighbours): OutFindNeighbours {
    return {
      id: payload[0],
      timestamp: timestamp.decode(payload[1]),
    }
  },
}

type InNeighbours = { peers: PeerInfo[]; timestamp?: number }
type OutNeighbours = { [0]: Uint8Array[][]; [1]: Uint8Array }

const neighbours = {
  encode(obj: InNeighbours): OutNeighbours {
    return [
      obj.peers.map((peer: PeerInfo) => {
        const ep = endpoint.encode(peer) // [address, udpPort, tcpPort] - array of 3 Uint8Arrays
        if (!peer.id) throw new Error('Peer must have id for neighbours message')
        return [...ep, peer.id] // [address, udpPort, tcpPort, id] - array of 4 Uint8Arrays
      }),
      timestamp.encode(obj.timestamp),
    ]
  },
  decode(payload: OutNeighbours): InNeighbours {
    return {
      peers: payload[0].map((data) => {
        // data is Uint8Array[] with [address, udpPort, tcpPort, id]
        if (data.length < 4) throw new Error('Invalid neighbours peer data')
        const epData = data.slice(0, 3) // First 3 elements are endpoint
        const id = data[3] // 4th element is id
        const endpointData = endpoint.decode(epData)
        return { ...endpointData, id }
      }),
      timestamp: timestamp.decode(payload[1]),
    }
  },
}

const messages: Record<string, { encode: (obj: any) => any; decode: (payload: any) => any }> = {
  ping,
  pong,
  findneighbours,
  neighbours,
}

// ---------- Message type codes ----------

export const MessageTypes = {
  byName: {
    ping: 0x01,
    pong: 0x02,
    findneighbours: 0x03,
    neighbours: 0x04,
  } as const,
  byType: {
    0x01: 'ping',
    0x02: 'pong',
    0x03: 'findneighbours',
    0x04: 'neighbours',
  } as Record<number, string>,
}

export type MessageTypeName = keyof typeof MessageTypes.byName

// ---------- Wire format ----------
// [0, 32) data hash
// [32, 96) signature
// 96 recoveryId
// 97 type
// [98, length) data

export function encode<T>(typename: MessageTypeName, data: T, privateKey: Uint8Array, common?: Common): Uint8Array {
  const type = MessageTypes.byName[typename]
  if (type === undefined) throw new Error(`Invalid typename: ${typename}`)
  
  const encodedMsg = messages[typename].encode(data)
  const typedata = concatBytes(Uint8Array.from([type]), RLP.encode(encodedMsg))

  const keccakFn = common?.customCrypto?.keccak256 ?? keccak256
  const signFn = common?.customCrypto?.ecsign ?? secp256k1.sign

  const sighash = keccakFn(typedata)
  const sig = signFn(sighash, privateKey)
  const hashdata = concatBytes(
    setLengthLeft(bigIntToBytes(sig.r), 32),
    setLengthLeft(bigIntToBytes(sig.s), 32),
    Uint8Array.from([sig.recovery]),
    typedata,
  )
  const hash = keccakFn(hashdata)
  return concatBytes(hash, hashdata)
}

export interface DecodedMessage {
  typename: string
  data: any
  publicKey: Uint8Array
  hash: Uint8Array
}

export function decode(bytes: Uint8Array, common?: Common): DecodedMessage {
  const keccakFn = common?.customCrypto?.keccak256 ?? keccak256
  const recoverFn = common?.customCrypto?.ecdsaRecover ?? ecdsaRecover

  const hash = keccakFn(bytes.subarray(32))
  assertEq(bytes.subarray(0, 32), hash, 'Hash verification failed', debug)

  const typedata = bytes.subarray(97)
  const type = typedata[0]
  const typename = MessageTypes.byType[type]
  if (typename === undefined) throw new Error(`Invalid type: ${type}`)
  
  const data = messages[typename].decode(unstrictDecode(typedata.subarray(1)))

  const sighash = keccakFn(typedata)
  const signature = bytes.subarray(32, 96)
  const recoverId = bytes[96]
  const publicKey = recoverFn(signature, recoverId, sighash, false)
  
  return { typename, data, publicKey, hash: bytes.subarray(0, 32) }
}

// Re-export types for external use
export type { OutFindNeighbours as FindNeighboursData, InNeighbours as NeighboursData, OutPing as PingData, OutPong as PongData }

