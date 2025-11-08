import crypto, { type ECDH } from "crypto";

export interface KeyMaterial {
	rxKey: Buffer;
	txKey: Buffer;
}

export class KeyPair {
	keyPair: ECDH;

	constructor(keyPair: ECDH) {
		this.keyPair = keyPair;
	}

	static generate(): KeyPair {
		const ecdh = crypto.createECDH("prime256v1");
		ecdh.generateKeys();
		return new KeyPair(ecdh);
	}

	public deriveKeys(shared: Buffer, isInitiator: boolean): KeyMaterial {
		const salt = crypto.createHash("sha256").update("bun-p2p-v1").digest();
		const prk = Buffer.from(
			crypto.hkdfSync("sha256", shared, salt, Buffer.from("session-keys"), 64),
		);
		const k1 = prk.subarray(0, 32);
		const k2 = prk.subarray(32, 64);
		return isInitiator ? { txKey: k1, rxKey: k2 } : { txKey: k2, rxKey: k1 };
	}

	public encrypt(key: Buffer, plaintext: Buffer, counter: bigint): Buffer {
		const iv = Buffer.alloc(12);
		iv.writeBigUInt64BE(counter, 4);
		const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
		const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();
		return Buffer.concat([iv, tag, ct]);
	}

	public decrypt(key: Buffer, blob: Buffer): Buffer {
		const iv = blob.subarray(0, 12);
		const tag = blob.subarray(12, 28);
		const ct = blob.subarray(28);
		const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ct), decipher.final()]);
	}
}
