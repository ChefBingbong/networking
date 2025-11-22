import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { idToKey } from "../kademlia/xor";
import type { PeerNode } from "../node";

export function createKadApi(node: PeerNode, port = 3001) {
	const app = new Hono();

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
