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

		if (cmd === "connections") {
			console.log(
				"Peers:",
				[...node.connections.keys()].join(", ") || "(none)",
			);
			return;
		}

		if (cmd === "echo" && a) {
			try {
				const ECHO_PROTOCOL = "/echo/1.0.0";
				const stream = await node.dialProtocol(multiaddr(a), ECHO_PROTOCOL);

				stream.addEventListener("message", (evt) => {
					console.log("echoed:", evt.data);
				});
				stream.send("hello world");
			} catch (e) {
				console.log("ping error:", e);
			}
			return;
		}
		if (cmd === "ping" && a) {
			try {
				const rtt = await pingViaProtocol(node, a);
				console.log(`RTT to ${a}: ${rtt}ms`);
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

		if (cmd === "kad") {
			const dump = node.getKadRoutingTable();
			console.log(
				`Kad table for ${node.address.toString()}: peers=${dump.totalPeers}, buckets=${dump.nonEmptyBuckets}`,
			);
			dump.buckets.forEach((b) => {
				console.log(
					`  bucket ${b.index}: size=${b.size}`,
					b.peers.map((p) => p.addr).join(", "),
				);
			});
			return;
		}

		if (cmd === "help") {
			console.log("peers | ping <id> | msg <id> <text>");
			return;
		}

		console.log("unknown command; try 'help'");
	});
}
