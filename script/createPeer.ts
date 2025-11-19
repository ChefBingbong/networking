import debug from "debug";
import { createNode } from "../src//node/createNode";
import type { ProtocolStream } from "../src/connection/protocol-stream";
import type { PeerNode } from "../src/node";
import { startCLI } from "./cli";

debug.enable("p2p*");

const PING_PROTOCOL = "/ping/1.0.0";
const PORT = parseInt(process.env.PORT || "0", 10); // 0 picks a free port

export function setupPingProtocolPing(node: PeerNode) {
	node.handleProtocol(PING_PROTOCOL, (stream: ProtocolStream) => {
		// This is the "pong" side: respond to ping messages
		stream.addEventListener("message", (evt) => {
			const msg = evt.data;
			if (!msg) return;

			if (msg.type === "ping") console.log("[ping] received ping:", msg);
			else if (msg.type === "pong") console.log("[ping] received pong:", msg);

			// echo back the same timestamp so the sender can compute RTT
			if (msg.type === "ping") stream.send({ type: "pong", ts: msg.ts });
		});

		stream.addEventListener("remoteCloseWrite", () => {
			stream.close();
		});
	});
}

const ECHO_PROTOCOL = "/echo/1.0.0";

function setupProtocols(node: PeerNode) {
	// This makes THIS node able to act as the "remote echo server"
	node.handleProtocol(ECHO_PROTOCOL, (stream) => {
		// Echo incoming messages back
		stream.addEventListener("message", (evt) => {
			console.log("[echo] received:", evt.data);
			stream.send(evt.data);
		});

		// When the remote writable end closes, close ours
		stream.addEventListener("remoteCloseWrite", () => {
			stream.close();
		});
	});
}

const node = await createNode({
	nodeTypes: "peer",
	host: "127.0.0.1",
	port: PORT,
	start: true,
});
setupProtocols(node);
setupPingProtocolPing(node);
startCLI(node);
