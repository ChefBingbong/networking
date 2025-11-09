import type { PeerNode } from "../src/node/node";

export function startCLI(node: PeerNode) {
	console.log(
		`\nCommands:\n  peers\n  ping <peerId>\n  msg <peerId> <text>\n  help\n`,
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

		if (cmd === "ping" && a) {
			try {
				const [error, mc] = await node.ensureConn(a);
				if (error) {
					console.log("ping error:", error);
					return;
				}
				if (!mc) return;
				// const sid = mc.openStream((msg) => {
				// 	console.log(`[${node.info.id}] ping reply from ${a}:`, msg);
				// 	mc.closeStream(sid);
				// });
				mc.send({ t: "PING", payload: { id: a } });
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
