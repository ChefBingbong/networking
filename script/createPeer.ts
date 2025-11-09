import debug from "debug";
import { createNode } from "../src//node/createNode";
import { startCLI } from "./cli";

debug.enable("p2p*");

const PORT = parseInt(process.env.PORT || "0", 10); // 0 picks a free port
const ID = process.env.ID || `node-${Math.floor(Math.random() * 1e6)}`;

const node = await createNode({
	nodeTypes: "peer",
	host: "127.0.0.1",
	port: PORT,
	id: ID,
	start: true,
});

startCLI(node as any);
