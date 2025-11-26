// scripts/demo-network.ts

// No imports needed for demo functionality
import { createNode } from "../src/node/createNode";
import { PeerNode } from "../src/node/node";

// TODO: replace this with whatever you already use to generate Secp256k1 keys

const HOST = "127.0.0.1";
const BASE_PORT = 4000;
const NODE_COUNT = 200;


/**
 * Periodically print analytics to the console.
 */
function startAnalyticsLoop(nodes: PeerNode[], intervalMs = 10_000) {
	let tick = 0;
	setInterval(() => {
		tick++;

		for (const node of nodes) {
			const rt = node.kad.numPeers();
			console.log(
				node.address.toString(),
				"| kadPeers =",
				rt,
				"| buckets =",
				node.kad.table.getNonEmptyBucketCount(),
			);
		}
	}, intervalMs);
}

async function main() {
	console.log(`Spinning up ${NODE_COUNT} nodes on ${HOST}:${BASE_PORT}..`);

	const nodes: PeerNode[] = [];

	// 1. Create all nodes
	for (let i = 0; i < NODE_COUNT; i++) {
		const node = await createNode({
			host: HOST,
			port: BASE_PORT + i,
			start: false,
			nodeTypes: "peer",
		});
		nodes.push(node);
	}

	// 2. Start all nodes (listener + internal loops)
	await Promise.all(nodes.map((n) => n.start()));

	console.log("All nodes started.");
	console.log(
		"Network bootstrap in progress… watch logs and analytics below.\n",
	);

	// Give the DHT a bit of time to bootstrap and measure RTTs.
	await new Promise((resolve) => setTimeout(resolve, 5_000));

	// 3. DSHT functionality removed - using standard Ethereum discovery protocol
	console.log("DSHT demo removed - nodes now use Ethereum-compatible discovery protocol");

	// 4. Start analytics loop
	startAnalyticsLoop(nodes, 10_000);
}

main().catch((err) => {
	console.error("Demo network crashed:", err);
	process.exit(1);
});

// DSHT demo utilities removed - functionality no longer available
