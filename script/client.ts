// tcp-client.ts
import net from "node:net";
import tls from "node:tls";
import { generateBoundCertificate, verifyPeerCertificate } from "./cert.js";

if (typeof process.versions.bun !== "undefined") {
	console.error(
		"This STARTTLS wrap pattern requires Node.js. Use `node` to run.",
	);
	process.exit(1);
}

const { certPEM, keyPEM, nodeKey } = await generateBoundCertificate();
console.log(
	"[TCP] client node pub:",
	Buffer.from(nodeKey.publicCompressed).toString("hex"),
);

const raw = net.createConnection({ host: "127.0.0.1", port: 8001 }, () => {
	raw.setNoDelay(true);
	raw.setKeepAlive(true, 10_000);
	raw.write("STARTTLS\n");
});

raw.once("data", async (buf) => {
	console.log("[TCP] client saw:", buf.toString("utf8").trim());
	if (buf.toString("utf8").trim() !== "READY") {
		console.error("[TCP] server refused upgrade");
		raw.destroy();
		return;
	}

	// stop plaintext
	raw.removeAllListeners("data");
	raw.removeAllListeners("error");
	raw.removeAllListeners("end");
	//   raw.resume()

	// wrap as TLS client
	const tlsSock = tls.connect({
		socket: raw,
		key: keyPEM,
		cert: certPEM,
		requestCert: true,
		rejectUnauthorized: false,
		minVersion: "TLSv1.3",
		maxVersion: "TLSv1.3",
		servername: "localhost",
	});

	//   tlsSock.resume()

	const t = setTimeout(() => {
		console.error("[TCP] client handshake timeout");
		try {
			tlsSock.destroy(new Error("handshake timeout"));
		} catch {}
	}, 20000);

	tlsSock.once("secureConnect", async () => {
		clearTimeout(t);
		try {
			const peer = tlsSock.getPeerCertificate(true);
			console.log("[TCP] client secure, have cert?", !!peer?.raw);
			if (!peer || !peer.raw)
				throw new Error("no server certificate presented");
			await verifyPeerCertificate(peer.raw);
			console.log("[TCP] client: server verified");
			tlsSock.on("data", (d) => process.stdout.write("[TCP] " + d.toString()));
			tlsSock.on("close", () => console.log("[TCP] client closed"));
		} catch (e: any) {
			console.error("[TCP] verify failed:", e.message || e);
			tlsSock.destroy();
		}
	});

	tlsSock.once("error", (e) => {
		clearTimeout(t);
		console.error("[TCP] client tls error:", e.message);
	});
});
