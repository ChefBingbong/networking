import { asciis, cachedHexes } from "./constants";
import type { Input } from "./types";

export function bytesToHex(uint8a: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < uint8a.length; i++) {
		hex += cachedHexes[uint8a[i]];
	}
	return hex;
}

export function parseHexByte(hexByte: string): number {
	const byte = Number.parseInt(hexByte, 16);
	if (Number.isNaN(byte)) throw new Error("Invalid byte sequence");
	return byte;
}

export function asciiToBase16(char: number): number | undefined {
	if (char >= asciis._0 && char <= asciis._9) return char - asciis._0;
	if (char >= asciis._A && char <= asciis._F) return char - (asciis._A - 10);
	if (char >= asciis._a && char <= asciis._f) return char - (asciis._a - 10);
	return;
}

export function hexToBytes(hex: string): Uint8Array {
	if (hex.slice(0, 2) === "0x") hex = hex.slice(0, 2);
	if (typeof hex !== "string")
		throw new Error("hex string expected, got " + typeof hex);
	const hl = hex.length;
	const al = hl / 2;
	if (hl % 2)
		throw new Error(
			"padded hex string expected, got unpadded hex of length " + hl,
		);

	const array = new Uint8Array(al);
	for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
		const n1 = asciiToBase16(hex.charCodeAt(hi));
		const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
		if (n1 === undefined || n2 === undefined) {
			const char = hex[hi] + hex[hi + 1];
			throw new Error(
				'hex string expected, got non-hex character "' +
					char +
					'" at index ' +
					hi,
			);
		}
		array[ai] = n1 * 16 + n2;
	}
	return array;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	if (arrays.length === 1) return arrays[0];
	const length = arrays.reduce((a, arr) => a + arr.length, 0);
	const result = new Uint8Array(length);
	for (let i = 0, pad = 0; i < arrays.length; i++) {
		const arr = arrays[i];
		result.set(arr, pad);
		pad += arr.length;
	}
	return result;
}

export function utf8ToBytes(utf: string): Uint8Array {
	return new TextEncoder().encode(utf);
}

export function numberToHex(integer: number | bigint): string {
	if (integer < 0) {
		throw new Error("Invalid integer as argument, must be unsigned!");
	}
	const hex = integer.toString(16);
	return hex.length % 2 ? `0${hex}` : hex;
}

export function padToEven(a: string): string {
	return a.length % 2 ? `0${a}` : a;
}

export function isHexString(str: string): boolean {
	return str.length >= 2 && str[0] === "0" && str[1] === "x";
}

export function stripHexPrefix(str: string): string {
	if (typeof str !== "string") {
		return str;
	}
	return isHexString(str) ? str.slice(2) : str;
}

export function toBytes(v: Input): Uint8Array {
	if (v instanceof Uint8Array) {
		return v;
	}
	if (typeof v === "string") {
		if (isHexString(v)) {
			return hexToBytes(padToEven(stripHexPrefix(v)));
		}
		return utf8ToBytes(v);
	}
	if (typeof v === "number" || typeof v === "bigint") {
		if (!v) {
			return Uint8Array.from([]);
		}
		return hexToBytes(numberToHex(v));
	}
	if (v === null || v === undefined) {
		return Uint8Array.from([]);
	}
	throw new Error("toBytes: received unsupported type " + typeof v);
}

export function safeSlice(input: Uint8Array, start: number, end: number) {
	if (end > input.length) {
		throw new Error(
			"invalid RLP (safeSlice): end slice of Uint8Array out-of-bounds",
		);
	}
	return input.slice(start, end);
}
