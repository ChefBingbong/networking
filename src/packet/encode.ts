import { type Packet, type PacketBase } from "./types";

export function encodeFrame(obj: PacketBase): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(body.length, 0);
	return Buffer.concat([len, body]);
}

export function decodeFrames(
	buf: Buffer,
	onFrame: (f: Packet) => void,
): Buffer {
	let off = 0;
	while (buf.length - off >= 4) {
		const len = buf.readUInt32BE(off);
		off += 4;
		if (buf.length - off < len) {
			off -= 4;
			break;
		}
		const slice = buf.subarray(off, off + len);
		off += len;
		try {
			onFrame(JSON.parse(slice.toString("utf8")));
		} catch (e) {
			console.error("Failed to parse frame:", e);
		}
	}
	return buf.subarray(off);
}

export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

export type StopFn = () => void;

export function startTicker(
	fn: () => void | Promise<void>,
	ms: number,
): StopFn {
	let ticking = true;
	let running = false;
	const id = setInterval(async () => {
		if (!ticking || running) return;
		try {
			running = true;
			await fn();
		} finally {
			running = false;
		}
	}, ms);
	return () => {
		ticking = false;
		clearInterval(id);
	};
}

export function jittered(baseMs: number, jitterPct = 0.2) {
	const d = baseMs * jitterPct;
	return Math.floor(baseMs - d + Math.random() * (2 * d));
}
