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
	// options.privateKey ??= await generateKeyPair("Ed25519");

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
			});
			return shouldStartAutomatically(node);
		}
		case "peer": {
			const node = new PeerNode({
				host: options.host,
				port: options.port,
				id: options.id,
			});
			return shouldStartAutomatically(node);
		}
		default:
			throw new Error(`Unknown node type: ${options.nodeTypes}`);
	}
}
