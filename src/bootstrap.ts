// src/bootstrap.ts
import { createServer, performUpgrade } from "./transport";
import { MuxedConnection } from "./mux";
import { type Frame, wait } from "./protocol";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "4000");
const ID = process.env.ID || `bootstrap-${PORT}`;

type PeerInfo = { id: string; host: string; port: number };

const ctx = {
  id: ID,
  host: HOST,
  port: PORT,
  isBootstrap: true,
  peers: new Map<string, PeerInfo>(),
};

const connections = new Map<string, MuxedConnection>(); // id -> conn
const lastSeen = new Map<string, number>();              // id -> ts (ms)

// Accept inbound dials; run upgrade; then handle frames
createServer(ctx, async (mc) => {
  try {
    console.log(`[${ctx.id}] inbound connection, starting upgrade`);
    await performUpgrade(mc, ctx, /*isInitiator=*/false);
    console.log(`[${ctx.id}] inbound upgrade complete`);
  } catch (e) {
    console.error(`[${ctx.id}] inbound upgrade failed:`, e);
    return;
  }
  mc.setOnFrame((f) => onFrame(mc, f));
});

function broadcast(frame: Frame) {
  for (const [, mc] of connections) {
    try { mc.send(frame); } catch {}
  }
}

function onFrame(mc: MuxedConnection, f: Frame) {
  if (f.t === "PEER_JOIN") {
    const { id, host, port } = f.payload as PeerInfo;
    ctx.peers.set(id, { id, host, port });
    connections.set(id, mc);
    lastSeen.set(id, Date.now()); // mark as seen on join
    // reply with full list
    mc.send({ t: "PEER_LIST", payload: { peers: [...ctx.peers.values()] } });
    // tell everyone
    broadcast({ t: "PEER_JOIN", payload: { id, host, port } });
    console.log(`[bootstrap] ${id} joined (${host}:${port})`);
  }

  if (f.t === "HEARTBEAT") {
    const { id } = (f.payload ?? {}) as { id: string };
    if (id) {
      lastSeen.set(id, Date.now());
         console.log(`[bootstrap] <- PONG from ${id}`);
      // no reply needed; encrypted channel already authenticates the sender
    }
  }

  // Optional: nodes may ping bootstrap; reply politely
  if (f.t === "PING") {
    console.log(`[bootstrap] <- PING from ${f.payload.id}`);
    mc.send({ t: "PONG", payload: { id: ctx.id } });
  }
}

// Eviction loop: scan every 15s; evict if > 75s since last heartbeat
(async () => {
  const CHECK_EVERY_MS = 15_000;
  const EVICT_AFTER_MS = 75_000; // ~2.5 * 30s

  while (true) {
    const now = Date.now();
    const evict: string[] = [];

    for (const [id] of ctx.peers) {
      const seen = lastSeen.get(id) ?? 0;
      if (now - seen > EVICT_AFTER_MS) {
        evict.push(id);
      }
    }

    if (evict.length) {
      for (const id of evict) {
        ctx.peers.delete(id);
        connections.delete(id);
        lastSeen.delete(id);
        console.log(`[bootstrap] removing ${id} (missed heartbeats)`);
        broadcast({ t: "PEER_LEAVE", payload: { id } });
      }
    }

    await wait(CHECK_EVERY_MS);
  }
})();
