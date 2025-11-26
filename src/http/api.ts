import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { PeerNode } from "../node";
// import type { BlockchainClientState } from "../blockchain/client/client";
type BlockchainClientState = any; // Optional - may not exist

let globalAppInstance: Hono | null = null;

export function getGlobalAppInstance(): Hono | null {
	return globalAppInstance;
}

export function createKadApi(
	node: PeerNode,
	port = 3001,
) {
	const app = new Hono();
	globalAppInstance = app;

	app.get("/", (c) =>
		c.json({
			nodeId: node.peerId.toString(),
			address: node.address.toString(),
		}),
	);

	app.get("/kad/table", (c) => {
		const rt = node.kad.table.dump();
		return c.json(rt);
	});

	app.get("/kad/buckets", (c) => {
		// Return detailed bucket structure with splits and peers
		// Check if client wants peer data (default: true for backward compatibility)
		const includePeers = c.req.query("includePeers") !== "false"
		const buckets = node.kad.table.getBucketStructure(includePeers);
		return c.json(buckets);
	});

	app.get("/kad/buckets/structure", (c) => {
		// Return detailed bucket structure with splits and peers
		// Check if client wants peer data (default: true for backward compatibility)
		const includePeers = c.req.query("includePeers") !== "false"
		const buckets = node.kad.table.getBucketStructure(includePeers);
		
		return c.json({
			totalBuckets: buckets.length,
			buckets: buckets.map((bucket) => ({
				bitDepth: bucket.bitDepth,
				bucketIndex: bucket.bucketIndex,
				peerCount: bucket.peerCount,
				maxSize: bucket.maxSize,
				canSplit: bucket.canSplit,
				utilization: bucket.maxSize > 0 
					? ((bucket.peerCount / bucket.maxSize) * 100).toFixed(1) + "%"
					: "0%",
				bucketPath: bucket.bucketPath,
				peers: bucket.peers, // Already formatted by getBucketStructure
			})),
		});
	});

	app.get("/kad/buckets/summary", (c) => {
		// Return bucket split summary
		const summary = node.kad.table.getBucketSplitSummary();
		return c.json(summary);
	});

	app.get("/kad/peers", (c) => {
		// Add pagination and limit support for performance
		const limitParam = c.req.query("limit");
		const limit = limitParam ? Math.min(Number.parseInt(limitParam, 10), 1000) : undefined;
		const offsetParam = c.req.query("offset");
		const offset = offsetParam ? Number.parseInt(offsetParam, 10) : 0;
		
		const allPeers = node.kad.getPeers();
		
		if (limit !== undefined || offset > 0) {
			const limited = allPeers.slice(offset, limit !== undefined ? offset + limit : undefined);
			return c.json({
				peers: limited,
				total: allPeers.length,
				offset,
				limit: limit ?? allPeers.length,
			});
		}
		
		return c.json(allPeers);
	});

	// DSHT endpoints removed - DSHT functionality was removed in migration to Ethereum-compatible discovery
	app.post("/kad/dsht/put", async (c) => {
		return c.json({ ok: false, error: "DSHT functionality has been removed. This endpoint is deprecated." }, 410);
	});

	app.get("/kad/dsht/get/:level/:key", async (c) => {
		return c.json({ ok: false, error: "DSHT functionality has been removed. This endpoint is deprecated." }, 410);
	});

	app.get("/kad/dsht/near/:key", async (c) => {
		return c.json({ ok: false, error: "DSHT functionality has been removed. This endpoint is deprecated." }, 410);
	});

	// Kademlia STORE/FIND_VALUE endpoints removed - value storage was removed in migration
	app.post("/kad/put", async (c) => {
		return c.json({ ok: false, error: "Kademlia value storage has been removed. This endpoint is deprecated." }, 410);
	});

	app.get("/kad/value/:key", async (c) => {
		return c.json({ found: false, error: "Kademlia value storage has been removed. This endpoint is deprecated." }, 410);
	});


	serve(
		{
			fetch: app.fetch,
			port,
		},
		(info) => {
			console.log(
				`Kad HTTP API for ${node.address.toString()} listening on http://localhost:${info.port}`,
			);
		},
	);

	return app;
}
