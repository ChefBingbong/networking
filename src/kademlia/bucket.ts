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
	 * Move the given contact to "most recently seen" position.
	 * If it doesn't exist, no-op.
	 */
	touch(contact: Contact): void {
		const idx = this.contacts.findIndex((c) => c.id === contact.id);
		if (idx === -1) return;
		const existing = this.contacts.splice(idx, 1)[0]!;
		// update addr in case it changed
		existing.addr = contact.addr;
		this.contacts.push(existing);
	}

	/**
	 * Insert a new contact into a non-full bucket.
	 * Caller MUST ensure !isFull() first.
	 */
	pushNew(contact: Contact): void {
		this.contacts.push({ ...contact });
	}

	/**
	 * Replace the oldest contact with the given new one.
	 * Caller decides when to call this (e.g. after failed PING).
	 */
	replaceOldest(newContact: Contact): void {
		if (this.contacts.length === 0) {
			this.contacts.push({ ...newContact });
			return;
		}
		this.contacts.shift();
		this.contacts.push({ ...newContact });
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
			peers: this.contacts.map((e) => ({
				...e,
			})),
		};
	}
}
