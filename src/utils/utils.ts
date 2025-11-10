import type { Multiaddr } from "@multiformats/multiaddr";
import { CODE_UNIX } from "@multiformats/multiaddr";
import { Unix } from "@multiformats/multiaddr-matcher";
import type {
	IpcSocketConnectOpts,
	ListenOptions,
	TcpSocketConnectOpts,
} from "net";
import os from "os";
import path from "path";
import { getNetConfig } from "./getNetConfig";

export type NetConfig =
	| ListenOptions
	| (IpcSocketConnectOpts & TcpSocketConnectOpts);

export function multiaddrToNetConfig(
	addr: Multiaddr,
	options: NetConfig = {},
): NetConfig {
	if (Unix.exactMatch(addr)) {
		const listenPath = addr
			.getComponents()
			.find((c) => c.code === CODE_UNIX)?.value;

		if (listenPath == null) {
			throw new Error(`Multiaddr ${addr} was not a Unix address`);
		}

		if (os.platform() === "win32") {
			return { path: path.join("\\\\.\\pipe\\", listenPath) };
		} else {
			return { path: listenPath };
		}
	}

	const config = getNetConfig(addr);
	const host = config.host;
	const port = config.port;

	// tcp listening
	return {
		host,
		port,
		ipv6Only: config.type !== "ip4",
		...options,
	};
}
