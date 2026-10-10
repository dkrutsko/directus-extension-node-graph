import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { canonicalJson, graphHash, sha256Hex } from '../src/shared/core';
import { doc, edge, node, validWorkflow } from './helpers';

const nodeSha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
	test('matches the FIPS 180-4 test vectors', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
		);
	});

	test('matches node:crypto across every padding boundary', () => {
		for (let length = 0; length <= 200; length++) {
			const text = 'x'.repeat(length);
			expect(sha256Hex(text)).toBe(nodeSha256(text));
		}
	});

	test('matches node:crypto for multi-byte and astral characters', () => {
		const samples = ['é', 'Über · größe', '日本語のテキスト', '😀🚀', 'a\u0000b', '  ', 'mixed ✓ ascii 😀 and ü'];
		for (const sample of samples) expect(sha256Hex(sample)).toBe(nodeSha256(sample));
	});

	test('encodes lone surrogates as U+FFFD, like TextEncoder and Buffer', () => {
		for (const sample of ['\ud800', 'a\udc00b', '\udbff\ud800']) expect(sha256Hex(sample)).toBe(nodeSha256(sample));
	});

	test('matches node:crypto for random strings', () => {
		let seed = 42;
		const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

		for (let i = 0; i < 300; i++) {
			const length = Math.floor(random() * 300);
			let text = '';
			for (let j = 0; j < length; j++) text += String.fromCodePoint(Math.floor(random() * 0x2ffff));
			expect(sha256Hex(text)).toBe(nodeSha256(text));
		}
	});

	test('handles a long input', () => {
		const text = 'graph '.repeat(50_000);
		expect(sha256Hex(text)).toBe(nodeSha256(text));
	});
});

describe('canonicalJson', () => {
	test('sorts object keys at every depth and keeps array order', () => {
		expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
	});

	test('skips undefined members and turns non-finite numbers into null', () => {
		expect(canonicalJson({ a: undefined, b: Number.NaN, c: [undefined, Infinity] })).toBe('{"b":null,"c":[null,null]}');
	});

	test('never emits forbidden keys', () => {
		const value = JSON.parse('{"__proto__": {"x": 1}, "a": 1}');
		expect(canonicalJson(value)).toBe('{"a":1}');
	});
});

describe('graphHash', () => {
	test('is "sha256:" plus 64 hex characters', () => {
		expect(graphHash(validWorkflow())).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test('hashes the documented canonical form', () => {
		const document = doc(
			[
				{ id: 'b', type: 'end', position: { x: 5, y: 5 }, data: { outcome: 'approved' } },
				{ id: 'a', type: 'start', position: { x: 0, y: 0 }, data: {} },
			],
			[{ id: 'e1', source: 'a', sourceHandle: 'next', target: 'b', targetHandle: 'in' }],
		);

		const canonical =
			'{"edges":[{"data":{},"id":"e1","source":"a","sourceHandle":"next","target":"b","targetHandle":"in","type":null}],' +
			'"nodes":[{"data":{},"id":"a","type":"start"},{"data":{"outcome":"approved"},"id":"b","type":"end"}]}';

		expect(graphHash(document)).toBe(`sha256:${nodeSha256(canonical)}`);
	});

	test('ignores positions, viewport, meta, the ruleset stamp and array order', () => {
		const base = validWorkflow();
		const hash = graphHash(base);

		const moved = {
			...base,
			nodes: [...base.nodes].reverse().map((item) => ({ ...item, position: { x: item.position.x + 999, y: -3 } })),
			edges: [...base.edges].reverse(),
			viewport: { x: 10, y: 20, zoom: 2 },
			ruleset: { key: 'other', version: 9 },
			meta: { nodeCount: 0, edgeCount: 0, errorCount: 0, warningCount: 0, counts: {}, graphHash: 'x' },
		};

		expect(graphHash(moved)).toBe(hash);
	});

	test('ignores object key order (a database may reorder JSON keys)', () => {
		const base = validWorkflow();

		const shuffle = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(shuffle);
			if (value && typeof value === 'object') {
				return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, shuffle(child)]));
			}
			return value;
		};

		expect(graphHash(shuffle(base) as typeof base)).toBe(graphHash(base));
	});

	test('changes when meaning changes', () => {
		const base = validWorkflow();
		const hash = graphHash(base);

		const withData = { ...base, nodes: base.nodes.map((item) => (item.id === 't' ? { ...item, data: { ...item.data, due_days: 9 } } : item)) };
		const withType = { ...base, edges: base.edges.map((item) => (item.id === 'e2' ? { ...item, type: 'flow' } : item)) };
		const withTarget = { ...base, edges: base.edges.map((item) => (item.id === 'e8' ? { ...item, target: 'no' } : item)) };
		const withNode = { ...base, nodes: [...base.nodes, node('x', 'task', { title: 'Extra' })] };

		for (const changed of [withData, withType, withTarget, withNode]) expect(graphHash(changed)).not.toBe(hash);
	});

	test('is deterministic for duplicate ids', () => {
		const a = doc([node('d', 'task', { title: 'A' }), node('d', 'task', { title: 'B' })]);
		const b = doc([...a.nodes].reverse());
		expect(graphHash(a)).toBe(graphHash(b));
	});

	test('does not throw on malformed documents', () => {
		expect(() => graphHash(null as never)).not.toThrow();
		expect(() => graphHash({ nodes: [null, 1], edges: 'x' } as never)).not.toThrow();
	});

	test('edge without data hashes like edge with empty data', () => {
		const a = doc([], [edge('e', 'a.next', 'b.in')]);
		const b = doc([], [edge('e', 'a.next', 'b.in', undefined, {})]);
		expect(graphHash(a)).toBe(graphHash(b));
	});
});
