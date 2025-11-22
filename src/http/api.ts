import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { BlockchainClientState } from "../blockchain/client/client";
import { idToKey } from "../kademlia/xor";
import type { PeerNode } from "../node";
import { addBlockchainApiRoutes } from "./blockchain-api";

let globalAppInstance: Hono | null = null;

export function getGlobalAppInstance(): Hono | null {
	return globalAppInstance;
}

export function createKadApi(
	node: PeerNode,
	port = 3001,
	blockchainClient?: BlockchainClientState,
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
		const rt = node.kad.table.dump();
		return c.json(rt.buckets);
	});

	app.get("/kad/peers", (c) => {
		const peers = node.kad.table.allContacts();
		return c.json(peers);
	});

	app.post("/kad/dsht/put", async (c) => {
		const body = (await c.req.json().catch(() => null)) as {
			key?: string;
			metadata?: Record<string, unknown>;
			levels?: number[];
		} | null;

		if (!body || !body.key) {
			return c.json({ ok: false, error: "key is required" }, 400);
		}

		const key = idToKey(body.key);
		await node.kad.dshtPut(key, body.metadata ?? {}, body.levels);
		return c.json({ ok: true });
	});

	app.get("/kad/dsht/get/:level/:key", async (c) => {
		const rawLevel = c.req.param("level");
		const keyParam = c.req.param("key");
		const limitParam = c.req.query("limit");

		const level = Number.parseInt(rawLevel, 10);
		if (Number.isNaN(level)) {
			return c.json({ ok: false, error: "invalid level" }, 400);
		}

		const key = idToKey(keyParam);
		const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

		const pointers = await node.kad.dshtGet(key, level, { limit });
		return c.json({ ok: true, pointers });
	});

	app.get("/kad/dsht/near/:key", async (c) => {
		const key = idToKey(c.req.param("key"));
		const limitParam = c.req.query("limit");
		const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

		const res = await node.kad.dshtGetNear(key, limit);
		return c.json(res);
	});

	app.post("/kad/put", async (c) => {
		const body = (await c.req.json().catch(() => null)) as {
			key?: string;
			value?: any;
		} | null;

		if (!body || !body.key) {
			return c.json({ ok: false, error: "key is required" }, 400);
		}

		const key = idToKey(body.key);
		await node.kad.storeValue(key, body.value);
		return c.json({ ok: true });
	});

	app.get("/kad/value/:key", async (c) => {
		const key = idToKey(c.req.param("key"));
		const value = await node.kad.findValue(key);

		if (value === null || value === undefined) {
			return c.json({ found: false });
		}
		return c.json({ found: true, value });
	});

	// Add blockchain API routes if client is provided (either as param or stored on node)
	const client = blockchainClient ?? (node as any).blockchainClient;
	if (client) {
		addBlockchainApiRoutes(app, client);
	}

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
