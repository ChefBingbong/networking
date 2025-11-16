import { multiaddr } from "@multiformats/multiaddr";
import type { PeerNode } from "../src/node/node";
import { pingViaProtocol } from "../src/protocol/ping";

export function startCLI(node: PeerNode) {
	console.log(
		`\nCommands:\n  peers\n  ping <peerId>\n discover\n advertise\n   msg <peerId> <text>\n  help\n`,
	);
	const stdin = process.stdin;
	stdin.setEncoding("utf8");
	stdin.on("data", async (line: string) => {
		const [cmd, a, ...rest] = line.trim().split(/\s+/);
		if (!cmd) return;

		if (cmd === "peers") {
			console.log("Peers:", [...node.peers.keys()].join(", ") || "(none)");
			return;
		}

		if (cmd === "connections") {
			console.log(
				"Peers:",
				[...node.connections.keys()].join(", ") || "(none)",
			);
			return;
		}
		if (cmd === "adverts") {
			console.log("Peers:", [...node.adverts.keys()].join(", ") || "(none)");
			return;
		}

		if (cmd === "ping" && a) {
			try {
				const ECHO_PROTOCOL = "/echo/1.0.0";
				// const [error, mc] = await node.ensureConnection(a);
				// if (error) {
				// 	console.log("ping error:", error);
				// 	return;
				// }
				// if (!mc) return;
				// // const sid = mc.openStream((msg) => {
				// // 	console.log(`[${node.info.id}] ping reply from ${a}:`, msg);
				// // 	mc.closeStream(sid);
				// // });
				// mc.send({ t: "PING", payload: { id: a } });
				// remote node
				// node.handleProtocol(ECHO_PROTOCOL, (stream) => {
				// 	// echo incoming messages back
				// 	stream.addEventListener("message", (evt) => {
				// 		console.log("echo protocol received:", evt.data);
				// 		stream.send(evt.data);
				// 	});

				// 	// when the remote writable end closes, close ours
				// 	stream.addEventListener("remoteCloseWrite", () => {
				// 		stream.close();
				// 	});
				// });

				// local node
				// const [error, conn] = await node.dial(a);
				// if (error || !conn) throw error ?? new Error("dial failed");

				// turn the existing connection into an echo protocol stream:
				const stream = await node.dialProtocol(multiaddr(a), ECHO_PROTOCOL);
				// (you’d need to expose protocolManager or wrap this in a method)

				stream.addEventListener("message", (evt) => {
					console.log("echoed:", evt.data);
				});
				stream.send("hello world");
			} catch (e) {
				console.log("ping error:", e);
			}
			return;
		}
		if (cmd === "ping2" && a) {
			try {
				const rtt = await pingViaProtocol(node, a);
			} catch (e) {
				console.log("ping2 error:", e);
			}
			return;
		}

		if (cmd === "discover") {
			try {
				await node.discoverPeers();
			} catch (e) {
				console.log("ping error:", e);
			}
			return;
		}

		if (cmd === "a") {
			try {
				node.broadcastAdvert();
			} catch (e) {
				console.log("ping error:", e);
			}
			return;
		}

		// if (cmd === "msg" && a) {
		// 	const text = rest.join(" ");
		// 	try {
		// 		const mc = await ensureConn(a);
		// 		mc.send({ t: "MSG", from: node.info.id, to: a, payload: { text } });
		// 	} catch (e) {
		// 		console.log("msg error:", e);
		// 	}
		// 	return;
		// }

		if (cmd === "help") {
			console.log("peers | ping <id> | msg <id> <text>");
			return;
		}

		console.log("unknown command; try 'help'");
	});
}
