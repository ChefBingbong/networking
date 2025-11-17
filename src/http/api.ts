// src/http/kad-api-hono.ts

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { PeerNode } from "../node"; // adjust import path if needed

export function createKadApi(node: PeerNode, port = 3001) {
	const app = new Hono();

	// Basic info
	app.get("/", (c) =>
		c.json({
			nodeId: node.peerId.toString(),
			address: node.address.toString(),
		}),
	);

	// Full routing table
	app.get("/kad/table", (c) => {
		const rt = node.kad.dumpRoutingTable();
		return c.json(rt);
	});

	// Buckets only
	app.get("/kad/buckets", (c) => {
		const rt = node.kad.dumpRoutingTable();
		return c.json(rt.buckets);
	});

	// Flattened Kad peers
	app.get("/kad/peers", (c) => {
		const peers = node.kad.getKnownKadPeers();
		return c.json(peers);
	});

	// PUT value
	app.post("/kad/put", async (c) => {
		const body = (await c.req.json().catch(() => null)) as {
			key?: string;
			value?: any;
		} | null;

		if (!body || !body.key) {
			return c.json({ ok: false, error: "key is required" }, 400);
		}

		await node.kad.putValue(body.key, body.value);
		return c.json({ ok: true });
	});

	// FIND value
	app.get("/kad/value/:key", async (c) => {
		const key = c.req.param("key");
		const value = await node.kad.findValue(key);

		if (value === null || value === undefined) {
			return c.json({ found: false });
		}
		return c.json({ found: true, value });
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
