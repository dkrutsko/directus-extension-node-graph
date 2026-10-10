/**
 * Opaque element ids. Ids are never derived from labels, so renaming a node
 * never rewrites the edges that point at it.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 12;

/** 252 is the largest multiple of 36 below 256; bytes above it are redrawn so every character is equally likely. */
const UNBIASED_LIMIT = 252;

interface RandomSource {
	getRandomValues<T extends Uint8Array>(array: T): T;
}

/**
 * Web Crypto is a global in every browser Directus supports and in Node 22
 * (`globalThis.crypto`). Core is compiled without DOM or Node typings, so the
 * global is read through a minimal local type.
 */
function randomSource(): RandomSource | null {
	const candidate = (globalThis as { crypto?: Partial<RandomSource> }).crypto;
	return candidate && typeof candidate.getRandomValues === 'function' ? (candidate as RandomSource) : null;
}

/**
 * `${prefix}_` followed by 12 random base-36 characters (about 62 bits), for
 * example `n_k3x9p2qa7hdm`. The editor uses prefix `n` for nodes and `e` for
 * edges, which also keeps node and edge ids apart for any code that keeps
 * both in one id space (validation reports an id shared by a node and a
 * connection as `duplicate_id`).
 */
export function generateId(prefix: string): string {
	const source = randomSource();
	let id = '';

	while (id.length < ID_LENGTH) {
		const bytes = new Uint8Array(ID_LENGTH * 2);

		if (source) {
			source.getRandomValues(bytes);
		} else {
			// Not reached in supported environments; keeps generateId total.
			for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
		}

		for (const byte of bytes) {
			if (byte >= UNBIASED_LIMIT) continue;
			id += ALPHABET[byte % ALPHABET.length];
			if (id.length === ID_LENGTH) break;
		}
	}

	return `${prefix}_${id}`;
}
