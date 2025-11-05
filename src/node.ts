// src/node.ts
import net from "net";
import { createServer, connect, performUpgrade } from "./transport";
import { type Frame, wait } from "./protocol";
import { MuxedConnection } from "./mux";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "0"); // 0 picks a free port
const BOOTSTRAP_HOST = process.env.BOOTSTRAP_HOST || "127.0.0.1";
const BOOTSTRAP_PORT = parseInt(process.env.BOOTSTRAP_PORT || "4000");
const ID = process.env.ID || `node-${Math.floor(Math.random() * 1e6)}`;

type PeerInfo = { id: string; host: string; port: number };

const ctx = {
  id: ID,
  host: HOST,
  port: PORT,
  isBootstrap: false,
  peers: new Map<string, PeerInfo>(),
};

let serverConnMap = new Map<string, MuxedConnection>(); // id -> conn
let bootstrapConn: MuxedConnection | null = null;

// Accept inbound peer connections and upgrade them
const srv = createServer(ctx, async (mc) => {
  try {
    console.log(`[${ctx.id}] inbound connection, starting upgrade`);
    await performUpgrade(mc, ctx, /*isInitiator=*/false);
    console.log(`[${ctx.id}] inbound upgrade complete`);
  } catch (e) {
    console.error(`[${ctx.id}] inbound upgrade failed:`, e);
    return;
  }
  mc.setOnFrame((f) => onPeerFrame(mc, f));
});

(async () => {
  await wait(200);
  const address = srv.address() as net.AddressInfo;
  ctx.port = address.port;
  console.log(`[${ctx.id}] server bound on ${ctx.host}:${ctx.port}`);

  console.log(`[${ctx.id}] dialing bootstrap ${BOOTSTRAP_HOST}:${BOOTSTRAP_PORT}`);
  const bs = await connect(ctx, { id: "bootstrap", host: BOOTSTRAP_HOST, port: BOOTSTRAP_PORT }, true);
  console.log(`[${ctx.id}] connected & upgraded to bootstrap`);
  bootstrapConn = bs;
  bs.setOnFrame(onBootstrapFrame);

  // Register with bootstrap
  bs.send({ t: "PEER_JOIN", payload: { id: ctx.id, host: ctx.host, port: ctx.port } });

  // Start periodic heartbeats to bootstrap
  startHeartbeatLoop();

  // Start CLI
  startCLI();
})().catch((e) => {
  console.error(`[${ctx.id}] fatal startup error:`, e);
  process.exit(1);
});

function jittered(baseMs: number, jitterPct = 0.2): number {
  const delta = baseMs * jitterPct;
  return Math.floor(baseMs - delta + Math.random() * (2 * delta));
}

function startHeartbeatLoop() {
  const BASE_MS = 30_000; // 30s
  (async () => {
    while (true) {
      const delay = jittered(BASE_MS, 0.2);
      await wait(delay);
      try {
        if (bootstrapConn) {
          bootstrapConn.send({ t: "HEARTBEAT", payload: { id: ctx.id, ts: Date.now() } });
        }
      } catch (e) {
        // If connection is broken, the reconnect logic (not shown here) would re-establish it.
        // We just skip this tick.
      }
    }
  })();
}

function onBootstrapFrame(f: Frame) {
  if (f.t === "PEER_LIST") {
    const list = f.payload.peers as PeerInfo[];
    for (const p of list) {
      if (p.id === ctx.id) continue;
      ctx.peers.set(p.id, p);
    }
    console.log(`[${ctx.id}] received peer list:`, [...ctx.peers.keys()].join(", ") || "(none)");
  }
  if (f.t === "PEER_JOIN") {
    const p = f.payload as PeerInfo;
    if (p.id !== ctx.id) {
      ctx.peers.set(p.id, p);
      console.log(`[${ctx.id}] peer joined: ${p.id}`);
    }
  }
  if (f.t === "PEER_LEAVE") {
    const { id } = f.payload as { id: string };
    ctx.peers.delete(id);
    serverConnMap.delete(id);
    console.log(`[${ctx.id}] peer left: ${id}`);
  }

  // Optional courtesy response if someone pings us
  if (f.t === "PING") {
    console.log(`[${ctx.id}] <- PING from bootstrap`);
    bootstrapConn?.send({ t: "PONG", payload: { id: ctx.id } });
  }
}

function onPeerFrame(mc: MuxedConnection, f: Frame) {
  if (f.t === "PING") {
    mc.send({ t: "PONG", payload: { id: ctx.id } });
  } else if (f.t === "MSG") {
    console.log(`[${ctx.id}] <${f.from}>: ${f.payload?.text}`);
  }
}

async function ensureConn(id: string): Promise<MuxedConnection> {
  if (serverConnMap.has(id)) return serverConnMap.get(id)!;
  const p = ctx.peers.get(id);
  if (!p) throw new Error(`unknown peer ${id}`);
  const mc = await connect(ctx, p, true);
  mc.setOnFrame((f) => onPeerFrame(mc, f));
  serverConnMap.set(id, mc);
  return mc;
}

// CLI
function startCLI() {
  console.log(`\nCommands:\n  peers\n  ping <peerId>\n  msg <peerId> <text>\n  help\n`);
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  stdin.on("data", async (line: string) => {
    const [cmd, a, ...rest] = line.trim().split(/\s+/);
    if (!cmd) return;

    if (cmd === "peers") {
      console.log("Peers:", [...ctx.peers.keys()].join(", ") || "(none)");
      return;
    }

    if (cmd === "ping" && a) {
      try {
        const mc = await ensureConn(a);
        const sid = mc.openStream((msg) => {
          console.log(`[${ctx.id}] ping reply from ${a}:`, msg);
          mc.closeStream(sid);
        });
        mc.writeStream(sid, { t: "PING", ts: Date.now() });
      } catch (e) {
        console.log("ping error:", e);
      }
      return;
    }

    if (cmd === "msg" && a) {
      const text = rest.join(" ");
      try {
        const mc = await ensureConn(a);
        mc.send({ t: "MSG", from: ctx.id, to: a, payload: { text } });
      } catch (e) {
        console.log("msg error:", e);
      }
      return;
    }

    if (cmd === "help") {
      console.log("peers | ping <id> | msg <id> <text>");
      return;
    }

    console.log("unknown command; try 'help'");
  });
}
