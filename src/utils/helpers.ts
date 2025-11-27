import { isHexString } from "./internal.ts";

/**
 * Throws if a string is not hex prefixed
 * @param {string} input string to check hex prefix of
 */
export const assertIsHexString = (input: string): void => {
	if (!isHexString(input)) {
		const msg = `This method only supports 0x-prefixed hex strings but input was: ${input}`;
		throw new Error(msg);
	}
};

export const assertIsBytes = (input: Uint8Array): void => {
	if (!(input instanceof Uint8Array)) {
		const msg = `This method only supports Uint8Array but input was: ${input}`;
		throw new Error(msg);
	}
};

export const assertIsArray = (input: number[]): void => {
	if (!Array.isArray(input)) {
		const msg = `This method only supports number arrays but input was: ${input}`;
		throw new Error(msg);
	}
};

export const assertIsString = (input: string): void => {
	if (typeof input !== "string") {
		const msg = `This method only supports strings but input was: ${input}`;
		throw new Error(msg);
	}
};

/**
 * Creates an Error without a code property
 * @param message Error message
 * @returns Error instance
 */
export const EthereumJSErrorWithoutCode = (message: string): Error => {
	return new Error(message);
};
