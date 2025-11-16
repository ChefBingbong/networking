import debug from "debug";
import { createNode } from "../src//node/createNode";
import type { PeerNode } from "../src/node";
import { startCLI } from "./cli";

debug.enable("p2p*");

const PORT = parseInt(process.env.PORT || "0", 10); // 0 picks a free port
const ID = process.env.ID || `node-${Math.floor(Math.random() * 1e6)}`;

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
	id: ID,
	start: true,
});
setupProtocols(node as PeerNode);
startCLI(node as PeerNode);
