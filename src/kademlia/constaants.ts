// DISCV5 message packet types
type NodeId = string;
export enum PacketType {
	/**
	 * Ordinary message packet
	 */
	Message = 0,
	/**
	 * Sent when the recipient of an ordinary message packet cannot decrypt/authenticate the packet's message
	 */
	WhoAreYou,
	/**
	 * Sent following a WHOAREYOU.
	 * These packets establish a new session and carry handshake related data
	 * in addition to the encrypted/authenticated message
	 */
	Handshake,
}

export interface IStaticHeader {
	/**
	 * "discv5"
	 */
	protocolId: string;
	/**
	 * 2 bytes
	 */
	version: number;
	/**
	 * 1 byte
	 */
	flag: PacketType;
	/**
	 * 12 bytes
	 */
	nonce: Uint8Array;
	/**
	 * 2 bytes
	 */
	authdataSize: number;
}

export interface IHeader extends IStaticHeader {
	authdata: Uint8Array;
}

// A IHeader contains an "authdata
// the contents of which are dependent on the packet type

export interface IMessageAuthdata {
	/**
	 * 32 bytes
	 */
	srcId: NodeId;
}

export interface IWhoAreYouAuthdata {
	/**
	 * 16 bytes
	 */
	idNonce: Uint8Array;
	/**
	 * 8 bytes
	 */
	enrSeq: bigint;
}

export interface IHandshakeAuthdata {
	srcId: NodeId;
	sigSize: number;
	ephKeySize: number;
	idSignature: Uint8Array;
	ephPubkey: Uint8Array;
	// pre-encoded ENR
	record?: Uint8Array;
}

export interface IPacket {
	maskingIv: Uint8Array;
	header: IHeader;
	message: Uint8Array;
	messageAd?: Uint8Array;
}
export const MAX_PACKET_SIZE = 1280;
export const MIN_PACKET_SIZE = 63;

export const MASKING_KEY_SIZE = 16;

export const PROTOCOL_SIZE = 6;
export const VERSION_SIZE = 2;
export const FLAG_SIZE = 1;
export const NONCE_SIZE = 12;
export const AUTHDATA_SIZE_SIZE = 2;
export const STATIC_HEADER_SIZE = 23;

export const MESSAGE_AUTHDATA_SIZE = 32;
export const WHOAREYOU_AUTHDATA_SIZE = 24;
export const MIN_HANDSHAKE_AUTHDATA_SIZE = 34 + 64 + 33;

export const SIG_SIZE_SIZE = 1;
export const EPH_KEY_SIZE_SIZE = 1;

export const MASKING_IV_SIZE = 16;

export const ID_NONCE_SIZE = 16;

export const ERR_TOO_SMALL = "ERR_PACKET_TOO_SMALL";
export const ERR_TOO_LARGE = "ERR_PACKET_TOO_LARGE";

export const ERR_INVALID_PROTOCOL_ID = "ERR_INVALID_PROTOCOL_ID";
export const ERR_INVALID_VERSION = "ERR_INVALID_VERSION";
export const ERR_INVALID_FLAG = "ERR_INVALID_FLAG";

export const ERR_INVALID_AUTHDATA_SIZE = "ERR_INVALID_AUTHDATA_SIZE";
