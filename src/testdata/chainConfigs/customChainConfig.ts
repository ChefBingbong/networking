import type { ChainConfig } from "../../chain-config";

export const customChainConfig: ChainConfig = {
	name: "testnet",
	chainId: 12345,
	defaultHardfork: "byzantium",
	consensus: {
		type: "pow",
		algorithm: "ethash",
	},
	comment: "Private test network",
	url: "[TESTNET_URL]",
	genesis: {
		gasLimit: 1000000,
		difficulty: 1,
		nonce: "0xbb00000000000000",
		extraData:
			"0xcc000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
	},
	hardforks: [
		{
			name: "chainstart",
			block: 0,
		},
		{
			name: "homestead",
			block: 1,
		},
		{
			name: "tangerineWhistle",
			block: 2,
		},
		{
			name: "spuriousDragon",
			block: 3,
		},
		{
			name: "byzantium",
			block: 4,
		},
		{
			name: "constantinople",
			block: 5,
		},
		{
			name: "petersburg",
			block: 6,
		},
		{
			name: "istanbul",
			block: 7,
		},
		{
			name: "muirGlacier",
			block: 8,
		},
		{
			name: "berlin",
			block: 9,
		},
		{
			name: "london",
			block: 10,
		},
		{
			name: "paris",
			block: 11,
		},
	],
	bootstrapNodes: [],
};
