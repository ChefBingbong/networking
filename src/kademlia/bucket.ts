// src/kademlia/bucket.ts
import type { Contact, NodeId } from "./types";

export class KBucket {
	private contacts: Contact[] = []; // index 0 = least recently seen

	constructor(private readonly k: number) {}

	nonEmptyCount(): number {
		return this.contacts.length;
	}

	has(id: NodeId): boolean {
		return this.contacts.some((c) => c.id === id);
	}

	getAll(): Contact[] {
		return this.contacts.slice();
	}

	getOldest(): Contact | undefined {
		return this.contacts[0];
	}

	isFull(): boolean {
		return this.contacts.length >= this.k;
	}

	/**
	 * Move the given contact to "most recently seen".
	 */
	touch(contact: Contact): void {
		const idx = this.contacts.findIndex((c) => c.id === contact.id);
		if (idx === -1) return;

		const existing = this.contacts.splice(idx, 1)[0]!;
		// update metadata
		existing.addr = contact.addr;
		existing.host = contact.host;
		existing.port = contact.port;
		existing.lastSeen = contact.lastSeen ?? Date.now();

		this.contacts.push(existing);
	}

	/**
	 * Insert a new contact into a non-full bucket.
	 */
	pushNew(contact: Contact): void {
		const now = contact.lastSeen ?? Date.now();
		this.contacts.push({ ...contact, lastSeen: now });
	}

	/**
	 * Replace the oldest contact with the given new one.
	 */
	replaceOldest(newContact: Contact): void {
		const now = newContact.lastSeen ?? Date.now();
		const entry: Contact = { ...newContact, lastSeen: now };

		if (this.contacts.length === 0) {
			this.contacts.push(entry);
			return;
		}
		this.contacts.shift(); // drop oldest
		this.contacts.push(entry); // newest at tail
	}

	remove(id: NodeId): void {
		const idx = this.contacts.findIndex((c) => c.id === id);
		if (idx >= 0) this.contacts.splice(idx, 1);
	}

	dump(index: number) {
		if (this.contacts.length === 0) return null;
		return {
			index,
			size: this.contacts.length,
			peers: this.contacts.map((c) => ({
				id: c.id,
				addr: c.addr,
				host: c.host,
				port: c.port,
				lastSeen: c.lastSeen,
			})),
		};
	}
}
