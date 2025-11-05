// src/mux.ts
import net from "net";
import { type Frame, encodeFrame, decodeFrames } from "./protocol";
import { type KeyMaterial, decrypt, encrypt } from "./crypto";

export type FrameHandler = (f: Frame) => void;

export class MuxedConnection {
  private socket: net.Socket;
  // Explicit Buffer type and casts in concat to satisfy Bun’s Buffer generics
  private partial: Buffer = Buffer.alloc(0) as Buffer;
  private nextSid = 1;
  private streams = new Map<number, (data: any) => void>();
  private onFrameHandler: FrameHandler | null = null;

  private secure = false;
  private km: KeyMaterial | null = null;
  private txCounter = 1n;

  constructor(sock: net.Socket) {
    this.socket = sock;
    sock.on("data", (chunk) => this.onData(chunk as Buffer));
    sock.on("close", () => this.onClose());
  }

  setSecure(km: KeyMaterial) { this.km = km; this.secure = true; }

  setOnFrame(fn: FrameHandler) { this.onFrameHandler = fn; }

  private sendRaw(frame: Frame) { this.socket.write(encodeFrame(frame)); }

  send(frame: Frame) {
    if (this.secure && this.km) {
      const json = Buffer.from(JSON.stringify(frame), "utf8");
      const blob = encrypt(this.km.txKey, json, this.txCounter++);
      const wrapped: Frame = { t: "DATA", sid: 0, payload: { enc: true, blob: blob.toString("base64") } };
      this.sendRaw(wrapped);
    } else {
      this.sendRaw(frame);
    }
  }

  openStream(handler: (msg: any) => void): number {
    const sid = this.nextSid++;
    this.streams.set(sid, handler);
    this.send({ t: "OPEN", sid });
    return sid;
  }

  writeStream(sid: number, data: any) {
    this.send({ t: "DATA", sid, payload: data });
  }

  closeStream(sid: number) {
    this.send({ t: "CLOSE", sid });
    this.streams.delete(sid);
  }

  private onData(chunk: Buffer) {
    // Cast concat result to Buffer for TS
    this.partial = Buffer.concat([this.partial as Buffer, chunk as Buffer]) as unknown as Buffer;

    this.partial = decodeFrames(this.partial, (outer) => {
      if (outer && outer.t === "DATA" && outer.sid === 0 && this.secure && this.km && outer.payload?.enc) {
        try {
          const blob = Buffer.from(outer.payload.blob, "base64");
          const plain = decrypt(this.km.rxKey, blob);
          const inner = JSON.parse(plain.toString("utf8")) as Frame;
          this.dispatch(inner);
        } catch (e) {
          console.error("decrypt/parse failed:", e);
        }
      } else {
        this.dispatch(outer);
      }
    }) as unknown as Buffer; // decodeFrames returns Buffer; cast for TS in Bun
  }

  private dispatch(f: Frame) {
    if (f.sid && this.streams.has(f.sid)) {
      const h = this.streams.get(f.sid)!;
      if (f.t === "DATA") h(f.payload);
      if (f.t === "CLOSE") this.streams.delete(f.sid);
      return;
    }
    this.onFrameHandler?.(f);
  }

  private onClose() {
    this.streams.clear();
  }
}
