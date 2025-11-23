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

export function getHostPortFromMultiaddr(addr: Multiaddr): {
	host: string;
	port: number;
} {
	const s = addr.toString(); // /ip4/127.0.0.1/tcp/4000/p2p/...
	const parts = s.split("/");
	const hostIdx = parts.indexOf("ip4") + 1;
	const tcpIdx = parts.indexOf("tcp") + 1;
	const host = parts[hostIdx] ?? "127.0.0.1";
	const port = parseInt(parts[tcpIdx] ?? "0", 10);
	return { host, port };
}

export function stringifyWithBigInt(value: unknown, space?: number) {
	const seen = new WeakSet<object>();

	const replacer = (_key: string, val: unknown) => {
		if (typeof val === "bigint") return val.toString();
		if (typeof val === "object" && val !== null) {
			if (seen.has(val as object)) return undefined; // drop circular refs
			seen.add(val as object);
		}
		return val as unknown;
	};

	return JSON.stringify(value, replacer, space);
}

export function parseWithBigInt(jsonString: string): unknown {
	return JSON.parse(jsonString, (_key, value) => {
	  if (typeof value === 'string' && /^\d+$/.test(value)) {
		try {
		  const num = BigInt(value);
		  if (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER) {
			return num;
		  }
		} catch {}
	  }
	  return value;
	});
  }