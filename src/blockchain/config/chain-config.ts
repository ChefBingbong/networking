// src/blockchain/config/chain-config.ts
import type { ChainConfig, Hardfork, GenesisConfig } from "../types";

export function getChainConfig(name: string): ChainConfig {
	// Default local development chain
	if (name === "local" || name === "dev") {
		return {
			chainId: 1337n,
			name: "local",
			hardforks: [
				{
					name: "frontier",
					block: 0n,
					eips: [],
				},
				{
					name: "homestead",
					block: 0n,
					eips: [2, 7, 8],
				},
				{
					name: "tangerineWhistle",
					block: 0n,
					eips: [150],
				},
				{
					name: "spuriousDragon",
					block: 0n,
					eips: [155, 158],
				},
				{
					name: "byzantium",
					block: 0n,
					eips: [100, 140, 196, 197, 198],
				},
				{
					name: "constantinople",
					block: 0n,
					eips: [145, 1014, 1052],
				},
				{
					name: "istanbul",
					block: 0n,
					eips: [152, 1108, 1344, 1884, 2028, 2200],
				},
				{
					name: "berlin",
					block: 0n,
					eips: [2565, 2929, 2930],
				},
				{
					name: "london",
					block: 0n,
					eips: [1559, 3198, 3529, 3541],
				},
			],
			genesis: {
				timestamp: "0x0",
				gasLimit: "0x1c9c380",
				difficulty: "0x1", // Very low difficulty for demo (was 0x400 = 1024)
				extraData: "0x",
				alloc: {},
			},
		};
	}

	// Mainnet-like config (simplified)
	if (name === "mainnet") {
		return {
			chainId: 1n,
			name: "mainnet",
			hardforks: [
				{
					name: "frontier",
					block: 0n,
					eips: [],
				},
				{
					name: "homestead",
					block: 1150000n,
					eips: [2, 7, 8],
				},
				{
					name: "tangerineWhistle",
					block: 2463000n,
					eips: [150],
				},
				{
					name: "spuriousDragon",
					block: 2675000n,
					eips: [155, 158],
				},
				{
					name: "byzantium",
					block: 4370000n,
					eips: [100, 140, 196, 197, 198],
				},
				{
					name: "constantinople",
					block: 7280000n,
					eips: [145, 1014, 1052],
				},
				{
					name: "istanbul",
					block: 9069000n,
					eips: [152, 1108, 1344, 1884, 2028, 2200],
				},
				{
					name: "berlin",
					block: 12244000n,
					eips: [2565, 2929, 2930],
				},
				{
					name: "london",
					block: 12965000n,
					eips: [1559, 3198, 3529, 3541],
				},
			],
			genesis: {
				timestamp: "0x0",
				gasLimit: "0x1388",
				difficulty: "0x400000000",
				extraData: "0x",
				alloc: {},
			},
		};
	}

	throw new Error(`Unknown chain config: ${name}`);
}

export function isHardforkActive(
	config: ChainConfig,
	hardfork: string,
	blockNumber: bigint,
): boolean {
	const hf = config.hardforks.find((h) => h.name === hardfork);
	if (!hf) return false;
	return blockNumber >= hf.block;
}

export function isEIPActive(
	config: ChainConfig,
	eip: number,
	blockNumber: bigint,
): boolean {
	for (const hf of config.hardforks) {
		if (blockNumber >= hf.block && hf.eips.includes(eip)) {
			return true;
		}
	}
	return false;
}

