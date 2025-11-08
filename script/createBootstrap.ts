import debug from "debug";
import { createNode } from "../src/node/createNode";

debug.enable("p2p*");

const PORT = parseInt(process.env.PORT || "4000", 10); // 0 picks a free port
const ID = process.env.ID || `bootstrap`;

await createNode({
	nodeTypes: "bootstrap",
	host: "127.0.0.1",
	port: PORT,
	id: ID,
	start: true,
});

// startCLI(node)
