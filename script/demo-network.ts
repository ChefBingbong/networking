// scripts/demo-network.ts

import { createNode } from "../src/node/createNode";
import { PeerNode } from "../src/node/node";
import type { NodeMetricsSnapshot } from "../src/node/types";

// TODO: replace this with whatever you already use to generate Secp256k1 keys

const HOST = "127.0.0.1";
const BASE_PORT = 4001;
const NODE_COUNT = 200;

// ---- helpers ---

function buildAdjacency(nodes: PeerNode[]) {
	const addrToIndex = new Map<string, number>();
	nodes.forEach((node, i) => {
		addrToIndex.set(node.address.toString(), i);
	});

	const neighbors: number[][] = nodes.map(() => []);

	nodes.forEach((node, i) => {
		for (const key of node.connections.keys()) {
			const j = addrToIndex.get(key);
			if (j === undefined || j === i) continue;
			if (!neighbors[i].includes(j)) neighbors[i].push(j);
			if (!neighbors[j].includes(i)) neighbors[j].push(i);
		}
	});

	return neighbors;
}

function computeAnalytics(nodes: PeerNode[]) {
	const N = nodes.length;
	const neighbors = buildAdjacency(nodes);

	const degrees = neighbors.map((n) => n.length);
	const totalDegree = degrees.reduce((a, b) => a + b, 0);
	const maxDegree = Math.max(...degrees);
	const minDegree = Math.min(...degrees);
	const avgDegree = N > 0 ? totalDegree / N : 0;
	const isolatedCount = degrees.filter((d) => d === 0).length;

	// edge count in undirected graph
	const edges = totalDegree / 2;
	const maxEdges = (N * (N - 1)) / 2;
	const density = maxEdges > 0 ? edges / maxEdges : 0;

	// how many nodes are fully connected?
	const fullyConnectedCount = degrees.filter((d) => d === N - 1).length;

	// histogram of degrees (optional)
	const hist = new Map<number, number>();
	for (const d of degrees) {
		hist.set(d, (hist.get(d) ?? 0) + 1);
	}

	// connected components (BFS)
	const visited = new Array<boolean>(N).fill(false);
	let components = 0;
	let largestComponent = 0;

	for (let i = 0; i < N; i++) {
		if (visited[i]) continue;
		components++;

		let size = 0;
		const queue: number[] = [i];
		visited[i] = true;

		while (queue.length > 0) {
			const u = queue.shift()!;
			size++;
			for (const v of neighbors[u]) {
				if (!visited[v]) {
					visited[v] = true;
					queue.push(v);
				}
			}
		}

		if (size > largestComponent) largestComponent = size;
	}

	return {
		degrees,
		minDegree,
		maxDegree,
		avgDegree,
		isolatedCount,
		edges,
		density,
		fullyConnectedCount,
		components,
		largestComponent,
		hist,
	};
}

function summarizeNetworkMetrics(nodes: PeerNode[]) {
	const snapshots: NodeMetricsSnapshot[] = nodes.map((n) =>
		n.getMetricsSnapshot(),
	);

	const avg = (xs: number[]) =>
		xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

	const allFirstConnects = snapshots.flatMap((s) =>
		s.firstConnectAvgMs > 0 ? [s.firstConnectAvgMs] : [],
	);
	const allPings = snapshots.flatMap((s) =>
		s.pingAvgMs > 0 ? [s.pingAvgMs] : [],
	);

	console.log("\n=== Per-node metrics ===");
	snapshots.forEach((s) => {
		console.log(
			`${s.address} | peers=${s.uniquePeers} | firstConnectAvg=${s.firstConnectAvgMs.toFixed(
				2,
			)}ms (${s.firstConnectCount} peers) | pingAvg=${s.pingAvgMs.toFixed(
				2,
			)}ms (${s.pingCount} samples)`,
		);
	});

	console.log("\n=== Network-wide metrics ===");
	console.log(
		`Nodes: ${snapshots.length}
Avg unique peers per node: ${avg(snapshots.map((s) => s.uniquePeers)).toFixed(
			2,
		)}
Avg first-connect latency (across nodes): ${avg(allFirstConnects).toFixed(2)}ms
Avg ping RTT (across nodes): ${avg(allPings).toFixed(2)}ms`,
	);
}

/**
 * Periodically print analytics to the console.
 */
function startAnalyticsLoop(nodes: PeerNode[], intervalMs = 10_000) {
	let tick = 0;
	setInterval(() => {
		tick++;
		const {
			degrees,
			minDegree,
			maxDegree,
			avgDegree,
			isolatedCount,
			edges,
			density,
			fullyConnectedCount,
			components,
			largestComponent,
			hist,
		} = computeAnalytics(nodes);

		const N = nodes.length;

		console.log(
			`\n=== Network tick #${tick} ===
Nodes: ${N}
Edges: ${edges}
Density: ${(density * 100).toFixed(1)}% of full mesh
Degrees: min=${minDegree}, max=${maxDegree}, avg=${avgDegree.toFixed(2)}
Isolated nodes: ${isolatedCount}
Fully connected nodes (degree = N-1): ${fullyConnectedCount}
Connected components: ${components}
Largest component size: ${largestComponent}`,
		);

		// small histogram print
		console.log("Degree histogram:");
		const sortedDegrees = Array.from(hist.keys()).sort((a, b) => a - b);
		for (const d of sortedDegrees) {
			console.log(`  degree ${d}: ${hist.get(d)} nodes`);
		}

		// first few nodes with their local connection counts
		const sample = nodes.slice(0, 10);
		for (const node of sample) {
			const addr = node.address.toString();
			const deg = node.connections.size;
			console.log(`  ${addr} -> connections: ${deg}`);
		}

		console.log("Latency:");
		summarizeLatency(nodes);

		console.log("Node metrics:");
		summarizeNetworkMetrics(nodes);

		for (const node of nodes) {
			const rt = node.getKadRoutingTable();
			console.log(
				node.address.toString(),
				"| kadPeers =",
				rt.totalPeers,
				"| buckets =",
				rt.nonEmptyBuckets,
			);
		}
	}, intervalMs);
}

function summarizeLatency(nodes: PeerNode[]) {
	const allConn = nodes.flatMap((n) =>
		Array.from(n.metrics.firstConnectLatencies.values()),
	);
	const allPing = nodes.flatMap((n) => n.metrics.pingLatencies);

	const avg = (xs: number[]) =>
		xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
	const min = (xs: number[]) => (xs.length ? Math.min(...xs) : 0);
	const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);

	console.log("\n=== Latency metrics ===");
	console.log(
		`First connects: count=${allConn.length}, avg=${avg(allConn).toFixed(
			2,
		)}ms, min=${min(allConn)}ms, max=${max(allConn)}ms`,
	);
	console.log(
		`Ping RTTs:      count=${allPing.length}, avg=${avg(allPing).toFixed(
			2,
		)}ms, min=${min(allPing)}ms, max=${max(allPing)}ms`,
	);
}

// ---- main ----

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

	// 3. Start analytics loop
	startAnalyticsLoop(nodes, 10_000);
}

main().catch((err) => {
	console.error("Demo network crashed:", err);
	process.exit(1);
});
