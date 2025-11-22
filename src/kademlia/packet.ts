import {
	bytesToUtf8,
	concatBytes,
	hexToBytes,
	utf8ToBytes,
} from "ethereum-cryptography/utils.js";
import Crypto from "node:crypto";
import {
	AUTHDATA_SIZE_SIZE,
	ERR_INVALID_FLAG,
	ERR_INVALID_PROTOCOL_ID,
	ERR_INVALID_VERSION,
	ERR_TOO_LARGE,
	ERR_TOO_SMALL,
	FLAG_SIZE,
	type IHeader,
	type IPacket,
	MASKING_IV_SIZE,
	MASKING_KEY_SIZE,
	MAX_PACKET_SIZE,
	MIN_PACKET_SIZE,
	NONCE_SIZE,
	PacketType,
	PROTOCOL_SIZE,
	STATIC_HEADER_SIZE,
	VERSION_SIZE,
} from "./constaants";

export class CodeError extends Error {
	code: string;
	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

export function numberToBytes(value: number, length: number): Uint8Array {
	const array = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		array[length - 1 - i] = (value >> (i * 8)) & 0xff;
	}
	return array;
}

export function bytesToNumber(
	array: Uint8Array,
	length: number,
	offset = 0,
): number {
	let value = 0;
	for (let i = 0; i < length; i++) {
		value = (value << 8) | array[offset + i];
	}
	return value;
}

export function encodePacket(destId: string, packet: IPacket): Uint8Array {
	return concatBytes(
		packet.maskingIv,
		encodeHeader(destId, packet.maskingIv, packet.header),
		packet.message,
	);
}

export function encodeHeader(
	destId: string,
	maskingIv: Uint8Array,
	header: IHeader,
): Uint8Array {
	const ctx = Crypto.createCipheriv(
		"aes-128-ctr",
		hexToBytes(destId).slice(0, MASKING_KEY_SIZE),
		maskingIv,
	);
	return ctx.update(
		concatBytes(
			// static header
			utf8ToBytes(header.protocolId),
			numberToBytes(header.version, VERSION_SIZE),
			numberToBytes(header.flag, FLAG_SIZE),
			header.nonce,
			numberToBytes(header.authdataSize, AUTHDATA_SIZE_SIZE),
			// authdata
			header.authdata,
		),
	);
}

export function decodePacket(srcId: string, data: Uint8Array): IPacket {
	if (data.length < MIN_PACKET_SIZE) {
		throw new CodeError(`Packet too small: ${data.length}`, ERR_TOO_SMALL);
	}
	if (data.length > MAX_PACKET_SIZE) {
		throw new CodeError(`Packet too large: ${data.length}`, ERR_TOO_LARGE);
	}

	const maskingIv = data.slice(0, MASKING_IV_SIZE);
	const [header, headerBuf] = decodeHeader(
		srcId,
		maskingIv,
		data.slice(MASKING_IV_SIZE),
	);

	const message = data.slice(MASKING_IV_SIZE + headerBuf.length);
	return {
		maskingIv,
		header,
		message,
		messageAd: concatBytes(maskingIv, headerBuf),
	};
}

/**
 * Return the decoded header and the header as a buffer
 */
export function decodeHeader(
	srcId: string,
	maskingIv: Uint8Array,
	data: Uint8Array,
): [IHeader, Uint8Array] {
	const ctx = Crypto.createDecipheriv(
		"aes-128-ctr",
		hexToBytes(srcId).slice(0, MASKING_KEY_SIZE),
		maskingIv,
	);
	// unmask the static header
	const staticHeaderBuf = ctx.update(data.slice(0, STATIC_HEADER_SIZE));

	// validate the static header field by field
	const protocolId = bytesToUtf8(staticHeaderBuf.slice(0, PROTOCOL_SIZE));
	if (protocolId !== "discv5") {
		throw new CodeError(
			`Invalid protocol id: ${protocolId}`,
			ERR_INVALID_PROTOCOL_ID,
		);
	}

	const version = bytesToNumber(
		staticHeaderBuf.slice(PROTOCOL_SIZE, PROTOCOL_SIZE + VERSION_SIZE),
		VERSION_SIZE,
	);
	if (version !== 1) {
		throw new CodeError(`Invalid version: ${version}`, ERR_INVALID_VERSION);
	}

	const flag = bytesToNumber(
		staticHeaderBuf.slice(
			PROTOCOL_SIZE + VERSION_SIZE,
			PROTOCOL_SIZE + VERSION_SIZE + FLAG_SIZE,
		),
		FLAG_SIZE,
	);
	if (PacketType[flag] == null) {
		throw new CodeError(`Invalid flag: ${flag}`, ERR_INVALID_FLAG);
	}

	const nonce = staticHeaderBuf.slice(
		PROTOCOL_SIZE + VERSION_SIZE + FLAG_SIZE,
		PROTOCOL_SIZE + VERSION_SIZE + FLAG_SIZE + NONCE_SIZE,
	);

	const authdataSize = bytesToNumber(
		staticHeaderBuf.slice(
			PROTOCOL_SIZE + VERSION_SIZE + FLAG_SIZE + NONCE_SIZE,
		),
		AUTHDATA_SIZE_SIZE,
	);

	// Once the authdataSize is known, unmask the authdata
	const authdata = ctx.update(
		data.slice(STATIC_HEADER_SIZE, STATIC_HEADER_SIZE + authdataSize),
	);

	return [
		{
			protocolId,
			version,
			flag,
			nonce,
			authdataSize,
			authdata,
		},
		Buffer.concat([staticHeaderBuf, authdata]),
	];
}
