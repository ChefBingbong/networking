// src/run.ts
import net from "net";
import type { PeerInfo } from "../src/transport/types";
import { createNode } from "./createPeer";

const ROLE = (process.env.ROLE || "peer") as "peer" | "bootstrap";
const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(
	process.env.PORT || (ROLE === "bootstrap" ? "4000" : "0"),
);
const ID = process.env.ID || `${ROLE}-${Math.floor(Math.random() * 1e6)}`;

const TRANSPORTS = (process.env.TRANSPORTS || "tcp")
	.split(",")
	.map((s) => s.trim()) as ("tcp" | "udp")[];

const BOOTSTRAP_HOST = process.env.BOOTSTRAP_HOST || "127.0.0.1";
const BOOTSTRAP_PORT = parseInt(process.env.BOOTSTRAP_PORT || "4000");
const BOOTSTRAP: PeerInfo = {
	id: "bootstrap",
	host: BOOTSTRAP_HOST,
	port: BOOTSTRAP_PORT,
};

(async () => {
	const node = createNode({
		role: ROLE,
		id: ID,
		host: HOST,
		port: PORT,
		transports: TRANSPORTS,
	});

	await node.startListening(TRANSPORTS);
	const bound = node["ctx"].port;
	console.log(
		`[${ID}] listening on ${HOST}:${bound} via [${TRANSPORTS.join(", ")}]`,
	);

	if (ROLE === "peer") {
		// Choose a transport to bootstrap on (first available)
		const bootKey = TRANSPORTS[0];
		console.log(
			`[${ID}] dialing bootstrap (${bootKey}) ${BOOTSTRAP.host}:${BOOTSTRAP.port}`,
		);
		console.log(bootKey);
		await node.connectBootstrap(BOOTSTRAP, bootKey);
	}

	// --- CLI (separate from class) ---
	console.log(
		`\nCommands:\n  peers\n  ping <peerId> [tcp|udp]\n  msg <peerId> <text> [tcp|udp]\n  help\n`,
	);
	const stdin = process.stdin;
	stdin.setEncoding("utf8");
	stdin.on("data", async (line: string) => {
		const [cmd, a, ...rest] = line.trim().split(/\s+/);
		if (!cmd) return;

		if (cmd === "peers") {
			const peers = [...node["ctx"].peers.keys()].join(", ") || "(none)";
			console.log("Peers:", peers);
			return;
		}

		if (cmd === "ping" && a) {
			const key =
				rest[rest.length - 1] === "tcp" || rest[rest.length - 1] === "udp"
					? (rest.pop() as "tcp" | "udp")
					: TRANSPORTS[0];
			try {
				console.log(a, key);
				// run.ts — after dialing in the 'ping' command
				const mc = await node.dialPeer(a, key);
				console.log(
					`[${ID}] ${key} connection to ${a} upgraded; opening stream...`,
				);
				const sid = mc.openStream((msg) => {
					console.log(`[${ID}] ping reply from ${a} (${key}):`, msg);
					mc.closeStream(sid);
				});
				mc.writeStream(sid, { t: "PING", ts: Date.now() });
			} catch (e) {
				console.log("ping error:", e);
			}
			return;
		}

		if (cmd === "msg" && a) {
			const maybeKey = rest[rest.length - 1];
			const key =
				maybeKey === "tcp" || maybeKey === "udp"
					? (rest.pop() as "tcp" | "udp")
					: TRANSPORTS[0];
			const text = rest.join(" ");
			try {
				const mc = await node.dialPeer(a, key);
				mc.send({ t: "MSG", from: ID, to: a, payload: { text } });
			} catch (e) {
				console.log("msg error:", e);
			}
			return;
		}

		if (cmd === "help") {
			console.log("peers | ping <id> [tcp|udp] | msg <id> <text> [tcp|udp]");
			return;
		}

		console.log("unknown command; try 'help'");
	});
})().catch((e) => {
	console.error(`[${ID}] fatal error:`, e);
	process.exit(1);
});
