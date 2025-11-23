// src/blockchain/db/database.ts
import { Level } from "level";
import type { Uint8Array as Uint8ArrayType } from "../types";

export interface Database {
	get(key: string): Promise<Uint8Array | undefined>;
	put(key: string, value: Uint8Array): Promise<void>;
	del(key: string): Promise<void>;
	batch(ops: Array<{ type: "put" | "del"; key: string; value?: Uint8Array }>): Promise<void>;
	close(): Promise<void>;
}

export function createDatabase(path: string): Database {
	const db = new Level<string, Uint8Array>(path, {
		valueEncoding: "buffer",
		keyEncoding: "utf8",
	});

	return {
		async get(key: string): Promise<Uint8Array | undefined> {
			try {
				return await db.get(key);
			} catch (error: any) {
				if (error.code === "LEVEL_NOT_FOUND") {
					return undefined;
				}
				throw error;
			}
		},
		async put(key: string, value: Uint8Array): Promise<void> {
			await db.put(key, value);
		},
		async del(key: string): Promise<void> {
			try {
				await db.del(key);
			} catch (error: any) {
				if (error.code !== "LEVEL_NOT_FOUND") {
					throw error;
				}
			}
		},
		async batch(
			ops: Array<{ type: "put" | "del"; key: string; value?: Uint8Array }>,
		): Promise<void> {
			await db.batch(ops);
		},
		async close(): Promise<void> {
			await db.close();
		},
	};
}

