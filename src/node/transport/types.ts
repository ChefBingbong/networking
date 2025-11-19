import type { Multiaddr } from "@multiformats/multiaddr";
import type { Encrypter } from "../../connection";
import type {
	ConnectionHandler,
	StreamOpenHandler,
} from "../../connection/types";
import type { NetConfig } from "../../utils/getNetConfig";

export interface TCPSocketOptions {
	noDelay?: boolean;
	keepAlive?: boolean;
	allowHalfOpen?: boolean;
	signal?: AbortSignal;
}
export interface CreateListenerOptions {
	upgrader: Encrypter;
}
export interface TCPCreateListenerOptions
	extends CreateListenerOptions,
		TCPSocketOptions {}

export type Status =
	| { code: "INACTIVE" }
	| {
			code: "ACTIVE";
			listeningAddr: Multiaddr;
			netConfig: NetConfig;
	  };

export interface Context extends TCPCreateListenerOptions {
	socketInactivityTimeout?: number;
	socketCloseTimeout?: number;
	maxConnections?: number;
	backlog?: number;
	frameHandler: ConnectionHandler;
	streamOpenHandler: StreamOpenHandler;
}

export type TransportDialOpts = {
	timeoutMs?: number;
	shouldCreateConnection?: boolean;
	maxActiveDials: number;
};

export type CreateTransportOptions = {
	frameHandler: ConnectionHandler;
	streamOpenHandler: StreamOpenHandler;
};
