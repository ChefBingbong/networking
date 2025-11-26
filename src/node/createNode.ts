import { generateSecp256k1KeyPrivPubPair } from "../secp256k1/utils";
import { peerIdFromPrivateKey } from "../session/peer-id";
import { PeerNode } from "./node";

type NodeOptions = {
	nodeTypes: "peer";
	host: string;
	port: number;
	privateKey?: CryptoKey;
	start?: boolean;
};

const bootStrapPk = Uint8Array.from([
	0x0c, 0x1e, 0x8f, 0x3b, 0x6a, 0x6c, 0x3f, 0x4b, 0x6f, 0x4e, 0x8f, 0x5e, 0x6d,
	0x7c, 0x8b, 0x9a, 0x0b, 0x1c, 0x2d, 0x3e, 0x4f, 0x50, 0x56, 0x07, 0x08, 0x09,
	0x0a, 0x00, 0xa0, 0x60, 0x82, 0xa8,
]);

export const BOOTSTRAP_ADDRS = [bootStrapPk];

// export const BOOTSTRAP_ADDRS: Multiaddr[] = [
// 	multiaddr("/ip4/127.0.0.1/tcp/4001"),
// ];

export async function createNode(options: NodeOptions) {
	const privateKey = generateSecp256k1KeyPrivPubPair(
		options.port === 4000 ? bootStrapPk : undefined,
	);
	const nodeInfo = { name: "test-p2p", version: "0.0.0" };
	const shouldStartAutomatically = (node: PeerNode) => {
		if (options.start) node.start();
		return node;
	};

	switch (options.nodeTypes) {
		case "peer": {
			const node = new PeerNode({
				host: options.host,
				port: options.port,
				id: "options.id,",
				peerId: peerIdFromPrivateKey(privateKey.privateKey),
				privateKey: privateKey.privateKey,
				nodeInfo,
			});
			return shouldStartAutomatically(node);
		}
		default:
			throw new Error(`Unknown node type: ${options.nodeTypes}`);
	}
}

export async function createNodeWithKey(options: NodeOptions) {
	const privateKey = generateSecp256k1KeyPrivPubPair(
		options.port === 4000 ? bootStrapPk : undefined,
	);
	const nodeInfo = { name: "test-p2p", version: "0.0.0" };
	const shouldStartAutomatically = (node: PeerNode) => {
		if (options.start) node.start();
		return node;
	};

	switch (options.nodeTypes) {
		case "peer": {
			const node = new PeerNode({
				host: options.host,
				port: options.port,
				id: "options.id,",
				peerId: peerIdFromPrivateKey(privateKey.privateKey),
				privateKey: privateKey.privateKey,
				nodeInfo,
			});
			return {
				node: shouldStartAutomatically(node),
				privateKey: privateKey.privateKey.raw,
			};
		}
		default:
			throw new Error(`Unknown node type: ${options.nodeTypes}`);
	}
}
