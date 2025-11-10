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

export interface RendezvousConfig {
	namespace: string;
	epochSeconds: number;
	slotsPerNode: number;
	querySlots: number;
}
