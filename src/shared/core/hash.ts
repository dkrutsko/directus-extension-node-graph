/**
 * Canonical JSON and a synchronous SHA-256, so `graphHash()` gives the same
 * answer in the browser (editor, display) and in Node (hook).
 *
 * Web Crypto's `subtle.digest` is async and Node's `crypto` module does not
 * exist in the browser, so the digest is implemented here in plain
 * JavaScript. Output is checked against `node:crypto` in the tests.
 */

import type { GraphDocument } from './types';
import { isPlainObject, safeKeys } from './util';

/**
 * JSON with object keys sorted (UTF-16 code unit order, which is what
 * `Array.prototype.sort` does in every engine). Arrays keep their order.
 * Number and string formatting is defined by ECMAScript's JSON.stringify, so
 * it is identical across engines. `undefined` members are skipped like
 * JSON.stringify does; non-finite numbers become null.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || value === undefined) return 'null';

	if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
	if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);

	if (Array.isArray(value)) {
		return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
	}

	if (isPlainObject(value)) {
		const parts: string[] = [];

		for (const key of safeKeys(value).sort()) {
			const member = value[key];
			if (member === undefined) continue;
			parts.push(JSON.stringify(key) + ':' + canonicalJson(member));
		}

		return '{' + parts.join(',') + '}';
	}

	// Functions, symbols, bigints and class instances are not graph data.
	return 'null';
}

/**
 * Position-free hash of a graph's meaning: nodes (id, type, data) and edges
 * (id, type, endpoints, data), each sorted by id. Positions, viewport, meta
 * and the ruleset stamp are excluded, so moving boxes, reordering the arrays
 * (some libraries bring the selected node to the end) or a database that
 * reorders object keys (MySQL 8) never changes it.
 */
export function graphHash(document: GraphDocument): string {
	const nodes: SortEntry[] = (Array.isArray(document?.nodes) ? document.nodes : []).map((node) => ({
		id: String(node?.id ?? ''),
		json: canonicalJson({ id: node?.id, type: node?.type, data: node?.data ?? {} }),
	}));

	const edges: SortEntry[] = (Array.isArray(document?.edges) ? document.edges : []).map((edge) => ({
		id: String(edge?.id ?? ''),
		json: canonicalJson({
			id: edge?.id,
			type: edge?.type ?? null,
			source: edge?.source,
			sourceHandle: edge?.sourceHandle,
			target: edge?.target,
			targetHandle: edge?.targetHandle,
			data: edge?.data ?? {},
		}),
	}));

	const canonical = '{"edges":[' + sortedJson(edges) + '],"nodes":[' + sortedJson(nodes) + ']}';

	return 'sha256:' + sha256Hex(canonical);
}

interface SortEntry {
	id: string;
	json: string;
}

/** Joins entries sorted by id; the canonical JSON breaks ties between duplicate ids. */
function sortedJson(entries: SortEntry[]): string {
	return entries
		.sort((a, b) => compareStrings(a.id, b.id) || compareStrings(a.json, b.json))
		.map((entry) => entry.json)
		.join(',');
}

/** Code unit order, the same in every engine (unlike localeCompare). */
function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------------ */
/* SHA-256 (FIPS 180-4)                                                     */
/* ------------------------------------------------------------------------ */

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
]);

/**
 * UTF-8 bytes of a string, without TextEncoder (core is compiled without DOM
 * or Node typings). Lone surrogates become U+FFFD, as TextEncoder does.
 */
export function utf8Bytes(text: string): Uint8Array {
	const bytes: number[] = [];

	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i);

		if (code >= 0xd800 && code <= 0xdbff) {
			const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;

			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				i++;
			} else {
				code = 0xfffd;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			code = 0xfffd;
		}

		if (code < 0x80) {
			bytes.push(code);
		} else if (code < 0x800) {
			bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code < 0x10000) {
			bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		} else {
			bytes.push(
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 0x3f),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f),
			);
		}
	}

	return Uint8Array.from(bytes);
}

/** SHA-256 of the UTF-8 encoding of `text`, as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
	const message = utf8Bytes(text);
	const bitLength = message.length * 8;

	// Pad: 0x80, zeros, then the 64-bit big-endian bit length, to a multiple of 64 bytes.
	const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(message);
	padded[message.length] = 0x80;

	const high = Math.floor(bitLength / 0x100000000);
	const low = bitLength >>> 0;

	for (let i = 0; i < 4; i++) {
		padded[paddedLength - 8 + i] = (high >>> (24 - i * 8)) & 0xff;
		padded[paddedLength - 4 + i] = (low >>> (24 - i * 8)) & 0xff;
	}

	const hash = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);

	const w = new Uint32Array(64);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let t = 0; t < 16; t++) {
			const j = offset + t * 4;
			w[t] = ((padded[j]! << 24) | (padded[j + 1]! << 16) | (padded[j + 2]! << 8) | padded[j + 3]!) >>> 0;
		}

		for (let t = 16; t < 64; t++) {
			const w15 = w[t - 15]!;
			const w2 = w[t - 2]!;
			const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
			const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
			w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
		}

		let a = hash[0]!;
		let b = hash[1]!;
		let c = hash[2]!;
		let d = hash[3]!;
		let e = hash[4]!;
		let f = hash[5]!;
		let g = hash[6]!;
		let h = hash[7]!;

		for (let t = 0; t < 64; t++) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + s1 + ch + K[t]! + w[t]!) >>> 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (s0 + maj) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		hash[0] = (hash[0]! + a) >>> 0;
		hash[1] = (hash[1]! + b) >>> 0;
		hash[2] = (hash[2]! + c) >>> 0;
		hash[3] = (hash[3]! + d) >>> 0;
		hash[4] = (hash[4]! + e) >>> 0;
		hash[5] = (hash[5]! + f) >>> 0;
		hash[6] = (hash[6]! + g) >>> 0;
		hash[7] = (hash[7]! + h) >>> 0;
	}

	let hex = '';

	for (const word of hash) {
		hex += word.toString(16).padStart(8, '0');
	}

	return hex;
}

function rotr(value: number, bits: number): number {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}
