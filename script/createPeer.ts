// src/createNode.ts
import { NodeCore, type NodeRole } from "../src/nodeCore";
import { TcpTransport } from "../src/transport/tcp";
import { UdpTransport } from "../src/transport/udp";

export type CreateNodeOpts = {
	role: NodeRole;
	id: string;
	host: string;
	port: number;
	transports: ("tcp" | "udp")[];
};

export function createNode(opts: CreateNodeOpts): NodeCore {
	const node = new NodeCore(opts.role, opts.host, opts.port, opts.id);

	// Register requested transports
	for (const t of opts.transports) {
		if (t === "tcp") node.registerTransports(new TcpTransport());
		if (t === "udp") node.registerTransports(new UdpTransport());
	}

	return node;
}
