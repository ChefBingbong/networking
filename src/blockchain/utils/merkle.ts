// src/blockchain/utils/merkle.ts
import { keccak256Hash, hashToHex } from "../utils";
import type { Hash } from "../types";

// Binary Merkle tree implementation
export function merkleRoot(leaves: Uint8Array[]): Hash {
	if (leaves.length === 0) {
		// Empty tree root (same as Ethereum)
		return "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421" as Hash;
	}

	if (leaves.length === 1) {
		return hashToHex(keccak256Hash(leaves[0]!)) as Hash;
	}

	// Build tree bottom-up
	let currentLevel = leaves.map((leaf) => keccak256Hash(leaf));

	while (currentLevel.length > 1) {
		const nextLevel: Uint8Array[] = [];

		// Process pairs
		for (let i = 0; i < currentLevel.length; i += 2) {
			const left = currentLevel[i]!;
			const right = i + 1 < currentLevel.length ? currentLevel[i + 1]! : left; // Duplicate if odd

			// Concatenate and hash
			const combined = new Uint8Array(left.length + right.length);
			combined.set(left, 0);
			combined.set(right, left.length);
			nextLevel.push(keccak256Hash(combined));
		}

		currentLevel = nextLevel;
	}

	return hashToHex(currentLevel[0]!) as Hash;
}

// Merkle Patricia Trie node types
export type TrieNode =
	| { type: "leaf"; key: Uint8Array; value: Uint8Array }
	| { type: "branch"; children: (TrieNode | null)[]; value?: Uint8Array }
	| { type: "extension"; key: Uint8Array; child: TrieNode };

// Simplified MPT implementation
export class MerklePatriciaTrie {
	private root: TrieNode | null = null;

	put(key: Uint8Array, value: Uint8Array): void {
		this.root = this.putNode(this.root, key, value, 0);
	}

	get(key: Uint8Array): Uint8Array | null {
		return this.getNode(this.root, key, 0);
	}

	rootHash(): Hash {
		if (!this.root) {
			return "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421" as Hash;
		}
		return this.hashNode(this.root);
	}

	private putNode(
		node: TrieNode | null,
		key: Uint8Array,
		value: Uint8Array,
		depth: number,
	): TrieNode {
		if (!node) {
			return { type: "leaf", key, value };
		}

		if (node.type === "leaf") {
			// Check if keys match
			if (this.keysMatch(node.key, key)) {
				return { type: "leaf", key, value };
			}

			// Keys differ - create branch
			const commonPrefix = this.commonPrefix(node.key, key);
			const branch: TrieNode = {
				type: "branch",
				children: new Array(16).fill(null),
			};

			if (commonPrefix.length === node.key.length && commonPrefix.length === key.length) {
				// Shouldn't happen, but handle it
				return { type: "leaf", key, value };
			}

			// Create extension for common prefix
			if (commonPrefix.length > 0) {
				const extension: TrieNode = {
					type: "extension",
					key: commonPrefix,
					child: branch,
				};

				// Add both values to branch
				if (node.key.length > commonPrefix.length) {
					const nodeNibble = node.key[commonPrefix.length]!;
					branch.children[nodeNibble] = {
						type: "leaf",
						key: node.key.slice(commonPrefix.length + 1),
						value: node.value,
					};
				} else {
					branch.value = node.value;
				}

				if (key.length > commonPrefix.length) {
					const keyNibble = key[commonPrefix.length]!;
					branch.children[keyNibble] = {
						type: "leaf",
						key: key.slice(commonPrefix.length + 1),
						value,
					};
				} else {
					branch.value = value;
				}

				return extension;
			}

			// No common prefix - create branch at root
			const nodeNibble = node.key[0]!;
			const keyNibble = key[0]!;

			branch.children[nodeNibble] = {
				type: "leaf",
				key: node.key.slice(1),
				value: node.value,
			};
			branch.children[keyNibble] = {
				type: "leaf",
				key: key.slice(1),
				value,
			};

			return branch;
		}

		if (node.type === "extension") {
			const commonPrefix = this.commonPrefix(node.key, key);
			if (commonPrefix.length === node.key.length) {
				// Extension key matches - recurse into child
				return {
					type: "extension",
					key: node.key,
					child: this.putNode(node.child, key.slice(commonPrefix.length), value, depth + commonPrefix.length),
				};
			}

			// Need to split extension
			const branch: TrieNode = {
				type: "branch",
				children: new Array(16).fill(null),
			};

			if (commonPrefix.length > 0) {
				// Create new extension for common prefix
				const extension: TrieNode = {
					type: "extension",
					key: commonPrefix,
					child: branch,
				};

				// Add existing extension
				if (node.key.length > commonPrefix.length) {
					const nodeNibble = node.key[commonPrefix.length]!;
					branch.children[nodeNibble] = {
						type: "extension",
						key: node.key.slice(commonPrefix.length + 1),
						child: node.child,
					};
				}

				// Add new leaf
				if (key.length > commonPrefix.length) {
					const keyNibble = key[commonPrefix.length]!;
					branch.children[keyNibble] = {
						type: "leaf",
						key: key.slice(commonPrefix.length + 1),
						value,
					};
				}

				return extension;
			}

			// No common prefix
			const nodeNibble = node.key[0]!;
			const keyNibble = key[0]!;

			branch.children[nodeNibble] = {
				type: "extension",
				key: node.key.slice(1),
				child: node.child,
			};
			branch.children[keyNibble] = {
				type: "leaf",
				key: key.slice(1),
				value,
			};

			return branch;
		}

		// Branch node
		if (key.length === 0) {
			return { ...node, value };
		}

		const nibble = key[0]!;
		const newChildren = [...node.children];
		newChildren[nibble] = this.putNode(
			node.children[nibble] ?? null,
			key.slice(1),
			value,
			depth + 1,
		);

		return {
			type: "branch",
			children: newChildren,
			value: node.value,
		};
	}

	private getNode(
		node: TrieNode | null,
		key: Uint8Array,
		depth: number,
	): Uint8Array | null {
		if (!node) {
			return null;
		}

		if (node.type === "leaf") {
			return this.keysMatch(node.key, key) ? node.value : null;
		}

		if (node.type === "extension") {
			if (key.length < node.key.length) {
				return null;
			}

			const prefix = key.slice(0, node.key.length);
			if (!this.keysMatch(prefix, node.key)) {
				return null;
			}

			return this.getNode(node.child, key.slice(node.key.length), depth + node.key.length);
		}

		// Branch node
		if (key.length === 0) {
			return node.value ?? null;
		}

		const nibble = key[0]!;
		const child = node.children[nibble];
		if (!child) {
			return null;
		}

		return this.getNode(child, key.slice(1), depth + 1);
	}

	private hashNode(node: TrieNode): Hash {
		if (node.type === "leaf") {
			const encoded = this.encodeLeaf(node);
			return hashToHex(keccak256Hash(encoded)) as Hash;
		}

		if (node.type === "extension") {
			const encoded = this.encodeExtension(node);
			return hashToHex(keccak256Hash(encoded)) as Hash;
		}

		// Branch
		const encoded = this.encodeBranch(node);
		return hashToHex(keccak256Hash(encoded)) as Hash;
	}

	private encodeLeaf(node: TrieNode & { type: "leaf" }): Uint8Array {
		const key = this.encodeKey(node.key, true);
		const value = this.rlpEncode(node.value);
		return this.rlpEncode([key, value]);
	}

	private encodeExtension(node: TrieNode & { type: "extension" }): Uint8Array {
		const key = this.encodeKey(node.key, false);
		const childHash = this.hashNode(node.child);
		return this.rlpEncode([key, hashToHex(childHash)]);
	}

	private encodeBranch(node: TrieNode & { type: "branch" }): Uint8Array {
		const items: (Uint8Array | string)[] = [];
		for (let i = 0; i < 16; i++) {
			const child = node.children[i];
			if (child) {
				items.push(this.hashNode(child));
			} else {
				items.push(new Uint8Array(0));
			}
		}
		if (node.value) {
			items.push(this.rlpEncode(node.value));
		} else {
			items.push(new Uint8Array(0));
		}
		return this.rlpEncode(items);
	}

	private encodeKey(key: Uint8Array, isLeaf: boolean): Uint8Array {
		// Simplified key encoding - in full MPT would use hex encoding with flags
		const prefix = isLeaf ? 0x20 : 0x00;
		const result = new Uint8Array(key.length + 1);
		result[0] = prefix;
		result.set(key, 1);
		return result;
	}

	private keysMatch(a: Uint8Array, b: Uint8Array): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	private commonPrefix(a: Uint8Array, b: Uint8Array): Uint8Array {
		const minLen = Math.min(a.length, b.length);
		const prefix: number[] = [];
		for (let i = 0; i < minLen; i++) {
			if (a[i] === b[i]) {
				prefix.push(a[i]!);
			} else {
				break;
			}
		}
		return Uint8Array.from(prefix);
	}

	private rlpEncode(data: Uint8Array | (Uint8Array | string)[]): Uint8Array {
		if (Array.isArray(data)) {
			const encoded = data.map((item) =>
				typeof item === "string" ? Uint8Array.from(Buffer.from(item.slice(2), "hex")) : item,
			);
			const totalLength = encoded.reduce((sum, item) => sum + item.length, 0);
			const result = new Uint8Array(totalLength + 1);
			result[0] = 0xc0 + encoded.length; // List prefix
			let offset = 1;
			for (const item of encoded) {
				result.set(item, offset);
				offset += item.length;
			}
			return result;
		}

		if (data.length === 1 && data[0]! < 0x80) {
			return data;
		}

		if (data.length < 56) {
			const result = new Uint8Array(data.length + 1);
			result[0] = 0x80 + data.length;
			result.set(data, 1);
			return result;
		}

		const lengthBytes = this.encodeLength(data.length);
		const result = new Uint8Array(data.length + 1 + lengthBytes.length);
		result[0] = 0xb7 + lengthBytes.length;
		result.set(lengthBytes, 1);
		result.set(data, 1 + lengthBytes.length);
		return result;
	}

	private encodeLength(length: number): Uint8Array {
		if (length < 256) {
			return Uint8Array.from([length]);
		}
		const bytes: number[] = [];
		let n = length;
		while (n > 0) {
			bytes.unshift(n & 0xff);
			n >>= 8;
		}
		return Uint8Array.from(bytes);
	}
}

