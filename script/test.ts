// tcp-server.ts
import net from "node:net";
import tls from "node:tls";
import { generateBoundCertificate, verifyPeerCertificate } from "./cert.js";
if (typeof process.versions.bun !== "undefined") {
	console.error(
		"This STARTTLS wrap pattern requires Node.js. Use `node` to run.",
	);
	process.exit(1);
}

const { certPEM, keyPEM } = await generateBoundCertificate();
console.log("[TCP] server listening on 8001");

const server = net.createServer((raw) => {
	raw.setNoDelay(true);
	raw.setKeepAlive(true, 10_000);

	let buf = "";
	let upgrading = false;

	const onData = (chunk: Buffer) => {
		if (upgrading) return;
		buf += chunk.toString("utf8");

		const nl = buf.indexOf("\n");
		if (nl === -1) return;

		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);

		console.log("[TCP] server got line:", line);
		if (line !== "STARTTLS") {
			raw.end("ERR expected STARTTLS\n");
			return;
		}

		// upgrading = true

		// 1) last plaintext byte
		raw.write("READY\n");

		// 2) stop plaintext handling
		raw.removeListener("data", onData);
		raw.removeAllListeners("error");
		raw.removeAllListeners("end");

		// 3) wrap as TLS server
		const tlsSock = new tls.TLSSocket(raw, {
			isServer: true, // ← REQUIRED on server wrap
			key: keyPEM,
			cert: certPEM,
			requestCert: true,
			rejectUnauthorized: false,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
		});

		const t = setTimeout(() => {
			console.error("[TCP] server handshake timeout");
			try {
				tlsSock.destroy(new Error("handshake timeout"));
			} catch {}
		}, 8000);

		tlsSock.once("secure", async () => {
			console.log("[TCP] secure connect");
			//   clearTimeout(t)
			try {
				const peer = tlsSock.getPeerCertificate(true);
				console.log("[TCP] server secure, have cert?", !!peer?.raw);
				if (!peer || !peer.raw)
					throw new Error("no client certificate presented");
				await verifyPeerCertificate(peer.raw);
				console.log("[TCP] server: client verified");
				tlsSock.write("HELLO OVER TLS\n");
			} catch (e: any) {
				console.error("[TCP] server verify failed:", e.message || e);
				tlsSock.destroy();
			}
		});

		tlsSock.once("error", (e) => {
			clearTimeout(t);
			console.error("[TCP] server tls error:", e.message);
		});
	};

	raw.on("data", onData);
	raw.once("error", (e) => console.error("[TCP] raw error:", e.message));
});

server.listen(8001);
