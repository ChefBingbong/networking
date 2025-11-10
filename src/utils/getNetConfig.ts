import type { Multiaddr } from "@multiformats/multiaddr";

export interface IP4NetConfig {
	type: "ip4";
	host: string;
	protocol?: "tcp" | "udp";
	port?: number;
	cidr?: number;
	sni?: string;
}

export type NetConfig = IP4NetConfig;

export function getNetConfig(ma: Multiaddr): NetConfig {
	const components = ma.getComponents();
	const config: any = {};
	let index = 0;

	if (!components[0]?.name) {
		throw new Error(`Multiaddr ${ma} has no components`);
	}
	if (components[index].name === "ip4" || components[index].name === "ip6") {
		config.type = components[index].name;
		config.host = components[index].value;
		index++;
	}

	if (components[index]?.name === "tcp" || components[index]?.name === "udp") {
		config.protocol = components[index].name === "tcp" ? "tcp" : "udp";
		config.port = parseInt(`${components[index].value}`, 10);
		index++;
	}

	if (config.type == null || config.host == null) {
		throw new Error(
			`Multiaddr ${ma} was not an IPv4, IPv6, DNS, DNS4, DNS6 or DNSADDR address`,
		);
	}

	if (
		components[index]?.name === "tls" &&
		components[index + 1]?.name === "sni"
	) {
		config.sni = components[index + 1].value;
		index += 2;
	}

	return config;
}
