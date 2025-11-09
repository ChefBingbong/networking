import { generateSecp256k1KeyPrivPubPair } from "../secp256k1/utils";
import { peerIdFromPrivateKey } from "../session/peer-id";
import { BootStrapNode } from "./bootstrap";
import { PeerNode } from "./node";

type NodeOptions = {
	nodeTypes: "bootstrap" | "peer";
	host: string;
	port: number;
	id: string;
	privateKey?: CryptoKey;
	start?: boolean;
};

export async function createNode(options: NodeOptions) {
	const privateKey = generateSecp256k1KeyPrivPubPair();
	const nodeInfo = { name: "test-p2p", version: "0.0.0" };
	const shouldStartAutomatically = (node: PeerNode | BootStrapNode) => {
		if (options.start) node.start();
		return node;
	};

	switch (options.nodeTypes) {
		case "bootstrap": {
			const node = new BootStrapNode({
				host: options.host,
				port: options.port,
				id: options.id,
				privateKey: privateKey.privateKey,
				peerId: peerIdFromPrivateKey(privateKey.privateKey),
				nodeInfo,
			});
			return shouldStartAutomatically(node);
		}
		case "peer": {
			const node = new PeerNode({
				host: options.host,
				port: options.port,
				id: options.id,
				privateKey: privateKey.privateKey,
				peerId: peerIdFromPrivateKey(privateKey.privateKey),
				nodeInfo,
			});
			return shouldStartAutomatically(node);
		}
		default:
			throw new Error(`Unknown node type: ${options.nodeTypes}`);
	}
}
