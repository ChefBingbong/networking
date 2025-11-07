import debug from "debug";
import { createNode } from "../src/createNode";

debug.enable("p2p*");

const PORT = parseInt(process.env.PORT || "0", 10); // 0 picks a free port
const ID = process.env.ID || `node-${Math.floor(Math.random() * 1e6)}`;

await createNode({
	nodeTypes: "bootstrap",
	host: "127.0.0.1",
	port: PORT,
	id: ID,
	start: true,
});
