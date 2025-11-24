import type { Input } from "./types";
import { concatBytes, hexToBytes, numberToHex, toBytes } from "./utils";

export function encode(input: Input): Uint8Array {
	if (Array.isArray(input)) {
		const output: Uint8Array[] = [];
		let outputLength = 0;
		for (let i = 0; i < input.length; i++) {
			const encoded = encode(input[i]);
			output.push(encoded);
			outputLength += encoded.length;
		}
		return concatBytes(encodeLength(outputLength, 192), ...output);
	}
	const inputBuf = toBytes(input);
	if (inputBuf.length === 1 && inputBuf[0] < 128) {
		return inputBuf;
	}
	return concatBytes(encodeLength(inputBuf.length, 128), inputBuf);
}

function encodeLength(len: number, offset: number): Uint8Array {
	if (len < 56) {
		return Uint8Array.from([len + offset]);
	}
	const hexLength = numberToHex(len);
	const lLength = hexLength.length / 2;
	const firstByte = numberToHex(offset + 55 + lLength);
	return Uint8Array.from(hexToBytes(firstByte + hexLength));
}
