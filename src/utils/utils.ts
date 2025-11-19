import type { Multiaddr } from "@multiformats/multiaddr";
import { CODE_UNIX, multiaddr } from "@multiformats/multiaddr";
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

export function multiaddrFromIp(ip: string, port: number | string) {
	if (!ip || !port) {
		throw new Error(`Invalid ip or port: ${ip}:${port}`);
	}
	try {
		return multiaddr(`/ip4/${ip}/tcp/${port}`);
	} catch {
		throw new Error(`Could not create tcp multiaddr from ${ip}:${port}`);
	}
}
