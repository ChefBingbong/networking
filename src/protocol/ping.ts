import { multiaddr } from "@multiformats/multiaddr";
import type { PeerNode } from "../node";

const PING_PROTOCOL = "/ping/1.0.0";

export async function pingViaProtocol(node: PeerNode, addrStr: string) {
	const addr = multiaddr(addrStr);

	const stream = await node.dialProtocol(addr, PING_PROTOCOL);

	return await new Promise<number>((resolve, reject) => {
		const start = Date.now();
		const pingMsg = { type: "ping", ts: start };

		const onMessage = (evt: { data: any }) => {
			const msg = evt.data;
			if (!msg || msg.type !== "pong") return;

			const rtt = Date.now() - start;
			console.log(
				`[${node.address.toString()}] pong recieved RTT to ${addrStr}: ${rtt}ms`,
			);

			stream.removeListener("message", onMessage as any);
			stream.close();
			resolve(rtt);
		};

		stream.addEventListener("message", onMessage as any);

		try {
			stream.send(pingMsg);
		} catch (err) {
			reject(err);
		}
	});
}
