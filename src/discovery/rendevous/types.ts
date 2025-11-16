export interface Advert {
	version: number;
	publicKey: string;
	addr: string;
	epoch: number;
	slot: string | undefined;
	slots: string[];
	expires_at: number;
	meta?: Record<string, any>;
}

export interface SignedAdvert {
	advert: Advert;
	signature: Uint8Array<ArrayBufferLike>;
}

// rendezvous/types.ts
export interface RendezvousConfig {
	namespace: string;
	epochSeconds: number;
	slotsPerNode: number;
	querySlots: number;

	// NEW: discovery / port-band configuration
	discoveryBasePort?: number; // lower bound of discovery band
	discoveryPortRange?: number; // number of ports in band
	discoveryHost?: string; // host to probe, usually same as node's host
}
