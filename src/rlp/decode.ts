import type { Decoded, Input, NestedUint8Array } from "./types";
import { bytesToHex, parseHexByte, safeSlice, toBytes } from "./utils";

export function decode(
	input: Input,
	stream?: false,
): Uint8Array | NestedUint8Array;
export function decode(input: Input, stream?: true): Decoded;
export function decode(
	input: Input,
	stream = false,
): Uint8Array | NestedUint8Array | Decoded {
	if (
		typeof input === "undefined" ||
		input === null ||
		(input as any).length === 0
	) {
		return Uint8Array.from([]);
	}

	const inputBytes = toBytes(input);
	const decoded = _decode(inputBytes);

	if (stream) {
		return {
			data: decoded.data,
			remainder: decoded.remainder.slice(),
		};
	}
	if (decoded.remainder.length !== 0) {
		throw new Error("invalid RLP: remainder must be zero");
	}

	return decoded.data;
}

function decodeLength(v: Uint8Array): number {
	if (v[0] === 0) {
		throw new Error("invalid RLP: extra zeros");
	}
	return parseHexByte(bytesToHex(v));
}

function _decode(input: Uint8Array): Decoded {
	let length: number,
		lLength: number,
		data: Uint8Array,
		innerRemainder: Uint8Array,
		d: Decoded;
	const decoded = [];
	const firstByte = input[0];

	if (firstByte <= 0x7f) {
		return {
			data: input.slice(0, 1),
			remainder: input.subarray(1),
		};
	} else if (firstByte <= 0xb7) {
		length = firstByte - 0x7f;
		if (firstByte === 0x80) {
			data = Uint8Array.from([]);
		} else {
			data = safeSlice(input, 1, length);
		}

		if (length === 2 && data[0] < 0x80) {
			throw new Error(
				"invalid RLP encoding: invalid prefix, single byte < 0x80 are not prefixed",
			);
		}

		return {
			data,
			remainder: input.subarray(length),
		};
	} else if (firstByte <= 0xbf) {
		lLength = firstByte - 0xb6;
		if (input.length - 1 < lLength) {
			throw new Error("invalid RLP: not enough bytes for string length");
		}
		length = decodeLength(safeSlice(input, 1, lLength));
		if (length <= 55) {
			throw new Error(
				"invalid RLP: expected string length to be greater than 55",
			);
		}
		data = safeSlice(input, lLength, length + lLength);

		return {
			data,
			remainder: input.subarray(length + lLength),
		};
	} else if (firstByte <= 0xf7) {
		length = firstByte - 0xbf;
		innerRemainder = safeSlice(input, 1, length);
		while (innerRemainder.length) {
			d = _decode(innerRemainder);
			decoded.push(d.data);
			innerRemainder = d.remainder;
		}

		return {
			data: decoded,
			remainder: input.subarray(length),
		};
	} else {
		lLength = firstByte - 0xf6;
		length = decodeLength(safeSlice(input, 1, lLength));
		if (length < 56) {
			throw new Error("invalid RLP: encoded list too short");
		}
		const totalLength = lLength + length;
		if (totalLength > input.length) {
			throw new Error("invalid RLP: total length is larger than the data");
		}

		innerRemainder = safeSlice(input, lLength, totalLength);

		while (innerRemainder.length) {
			d = _decode(innerRemainder);
			decoded.push(d.data);
			innerRemainder = d.remainder;
		}

		return {
			data: decoded,
			remainder: input.subarray(totalLength),
		};
	}
}
