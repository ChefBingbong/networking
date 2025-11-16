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

export async function createNode(options: NodeOptions) {
	const privateKey = generateSecp256k1KeyPrivPubPair();
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
