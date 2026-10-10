import { describe, expect, test } from 'vitest';
import { emptyDocument, normalizeDocument, starterDocument } from '../src/shared/core';
import { doc, edge, example, node, validWorkflow, variant } from './helpers';

describe('normalizeDocument', () => {
	test('treats null, undefined and empty strings as an empty document', () => {
		for (const raw of [null, undefined, '', '  ', 'null']) {
			expect(normalizeDocument(raw)).toEqual({ document: emptyDocument(), problems: [], fatal: [] });
		}
	});

	test('accepts a JSON string', () => {
		const result = normalizeDocument(JSON.stringify(validWorkflow()));
		expect(result.problems).toEqual([]);
		expect(result.document).toEqual(validWorkflow());
	});

	test('reports values that are not graph documents as fatal', () => {
		const cases: Array<[unknown, string]> = [
			['{ nope', 'The value is not valid JSON.'],
			[42, 'The value is not a graph document (expected an object).'],
			[[1, 2], 'The value is not a graph document (expected an object).'],
			[{ hello: 'world' }, 'The value is not a graph document (no "format", "nodes" or "edges").'],
			[{ format: 'vue-flow', nodes: [] }, 'The value has format "vue-flow", not "directus-node-graph".'],
			[{ format: 'directus-node-graph', version: 2, nodes: [] }, 'Document version 2 is not supported (expected 1).'],
		];

		for (const [raw, message] of cases) {
			const result = normalizeDocument(raw);
			expect(result.document).toEqual(emptyDocument());
			expect(result.fatal).toEqual([message]);
		}
	});

	test('repairs a missing format marker and version', () => {
		const result = normalizeDocument({ nodes: [node('a', 'task', { title: 'A' })], edges: [] });
		expect(result.fatal).toEqual([]);
		expect(result.problems).toEqual(['The "format" marker was missing and has been added.', 'The document version was missing and has been set to 1.']);
		expect(result.document.format).toBe('directus-node-graph');
		expect(result.document.nodes).toHaveLength(1);
	});

	test('strips content-versioning stamps at every depth, silently', () => {
		const stamp = { _user: 'u1', _date: '2026-10-09T00:00:00Z' };

		const raw = {
			...doc(
				[{ ...node('a', 'task', { title: 'A', nested: { deep: [{ x: 1, ...stamp }], ...stamp }, ...stamp }), position: { x: 1, y: 2, ...stamp }, ...stamp }],
				[{ ...edge('e', 'a.next', 'b.in', 'flow', { label: 'x', ...stamp }), ...stamp }],
			),
			viewport: { x: 0, y: 0, zoom: 1, ...stamp },
			...stamp,
		};

		const result = normalizeDocument(raw);
		expect(result.problems).toEqual([]);
		expect(JSON.stringify(result.document)).not.toMatch(/_user|_date/);
		expect(result.document.nodes[0]!.data).toEqual({ title: 'A', nested: { deep: [{ x: 1 }] } });
	});

	test('removes prototype keys, reports them as fatal and never pollutes prototypes', () => {
		const json =
			'{"format":"directus-node-graph","version":1,"__proto__":{"polluted":1},' +
			'"nodes":[{"id":"a","type":"task","position":{"x":0,"y":0},"data":{"title":"A","constructor":{"prototype":{"polluted":2}},"__proto__":{"polluted":3}},"prototype":1}],' +
			'"edges":[]}';

		const result = normalizeDocument(json);

		expect(result.fatal).toEqual([
			'nodes[0].data.constructor: the key is not allowed and was removed.',
			'nodes[0].data.__proto__: the key is not allowed and was removed.',
			'nodes[0].prototype: the key is not allowed and was removed.',
			'__proto__: the key is not allowed and was removed.',
		]);

		expect(result.document.nodes[0]!.data).toEqual({ title: 'A' });
		expect(Object.getPrototypeOf(result.document)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
	});

	test('removes nodes and edges it cannot identify, as fatal problems', () => {
		const raw = doc(
			[null as never, { type: 'task', position: { x: 0, y: 0 }, data: {} } as never, node('a', 'task')],
			[
				'x' as never,
				{ source: 'a', sourceHandle: 'next', target: 'b', targetHandle: 'in' } as never,
				{ id: 'e2', sourceHandle: 'next', target: 'b', targetHandle: 'in' } as never,
			],
		);

		const result = normalizeDocument(raw);

		expect(result.fatal).toEqual([
			'nodes[0]: not an object; it was removed.',
			'nodes[1]: no usable id; the node was removed.',
			'edges[0]: not an object; it was removed.',
			'edges[1]: no usable id; the connection was removed.',
			'Connection e2: the source or target is missing or not a usable id; the connection was removed.',
		]);

		expect(result.document.nodes.map((item) => item.id)).toEqual(['a']);
		expect(result.document.edges).toEqual([]);
	});

	test('coerces repairable shapes and reports them as repairs', () => {
		const raw = doc(
			[
				{ id: 7, type: 'task', data: { title: 'Seven' } } as never,
				{ id: 'b', position: { x: 'left', y: 0 }, data: 'oops' } as never,
			],
			[{ id: 'e', source: 7, target: 'b', type: 42 } as never],
		);

		const result = normalizeDocument(raw);

		expect(result.document.nodes).toEqual([
			{ id: '7', type: 'task', position: { x: 0, y: 0 }, data: { title: 'Seven' } },
			{ id: 'b', type: '', position: { x: 0, y: 0 }, data: {} },
		]);

		// A numeric type is kept as text (it may well be a key such as "42"), like any unknown type.
		expect(result.document.edges).toEqual([{ id: 'e', type: '42', source: '7', sourceHandle: '', target: 'b', targetHandle: '' }]);

		expect(result.problems).toEqual([
			'Node 7: the numeric id was converted to text.',
			'Node 7: the position was missing or malformed and has been set to (0, 0).',
			'Node b: the type was missing.',
			'Node b: the position was missing or malformed and has been set to (0, 0).',
			'Node b: "data" is not an object; it was replaced with an empty one.',
			'Connection e: a numeric node reference was converted to text.',
			'Connection e: the sourceHandle was missing.',
			'Connection e: the targetHandle was missing.',
			'Connection e: the numeric type was converted to text.',
		]);

		expect(result.fatal).toEqual(['Node b: "data" is not an object; it was replaced with an empty one.']);
	});

	test('preserves unknown node types, ports, keys and duplicate ids', () => {
		// Extra keys are what this test is about, so the literals are widened on purpose.
		const unknownNode = { ...node('a', 'retired_type', { anything: [1, { two: 2 }] }), label: 'kept', width: 120 };
		const unknownEdge = { ...edge('e', 'a.gone', 'zzz.in', 'old_type'), extra: true };

		const raw = {
			...doc([unknownNode, node('a', 'task', { title: 'Duplicate id' })], [unknownEdge]),
			futureKey: { keep: 'me' },
		};

		const result = normalizeDocument(raw);

		expect(result.problems).toEqual([]);
		expect(result.document.nodes[0]).toEqual(unknownNode);
		expect(result.document.nodes).toHaveLength(2);
		expect(result.document.edges[0]).toEqual(unknownEdge);
		expect((result.document as unknown as Record<string, unknown>)['futureKey']).toEqual({ keep: 'me' });
	});

	test('keeps a well-formed meta and stamp, drops malformed ones', () => {
		const meta = { nodeCount: 1, edgeCount: 0, errorCount: 0, warningCount: 1, counts: { task: 1 }, graphHash: 'sha256:x' };
		const good = normalizeDocument({ ...doc([]), meta, ruleset: { key: 'k', version: 2 }, viewport: { x: 1, y: 2, zoom: 0.5 } });

		expect(good.document.meta).toEqual(meta);
		expect(good.document.ruleset).toEqual({ key: 'k', version: 2 });
		expect(good.document.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 });

		const bad = normalizeDocument({ ...doc([]), meta: { nodeCount: -1 }, ruleset: { key: 1 }, viewport: { x: 0, y: 0, zoom: 0 } });

		expect(bad.document.meta).toBeUndefined();
		expect(bad.document.ruleset).toBeUndefined();
		expect(bad.document.viewport).toBeUndefined();
		expect(bad.fatal).toEqual([]);
	});

	test('cuts off values nested too deeply instead of overflowing the stack', () => {
		let deep: unknown = 'bottom';
		for (let i = 0; i < 5000; i++) deep = [deep];

		const result = normalizeDocument(doc([node('a', 'task', { deep })]));

		expect(result.fatal).toHaveLength(1);
		expect(result.fatal[0]).toMatch(/nested too deeply/);
	});

	test('round trip is byte-stable', () => {
		const messy = {
			version: 1,
			nodes: [
				{ data: { b: 1, a: { _user: 'x', z: [3, 2, 1] } }, type: 'task', id: 5, extra: { y: 1, x: 2 } },
				node('b', 'end', { outcome: 'approved' }),
			],
			edges: [{ targetHandle: 'in', target: 'b', sourceHandle: 'next', source: '5', id: 'e1', type: 'flow', data: { label: 'go' } }],
			viewport: { zoom: 1.25, y: -4, x: 10 },
			unknown: [1, 'two'],
		};

		const first = normalizeDocument(messy);
		const firstJson = JSON.stringify(first.document);

		const second = normalizeDocument(JSON.parse(firstJson));
		const secondJson = JSON.stringify(second.document);

		expect(second.problems).toEqual([]);
		expect(secondJson).toBe(firstJson);

		// From a string as well (the hook may read text from SQLite or MySQL).
		expect(JSON.stringify(normalizeDocument(firstJson).document)).toBe(firstJson);

		// Known keys come first in a fixed order; unknown keys follow in input order.
		expect(Object.keys(first.document)).toEqual(['format', 'version', 'nodes', 'edges', 'viewport', 'unknown']);
		expect(Object.keys(first.document.nodes[0]!)).toEqual(['id', 'type', 'position', 'data', 'extra']);
		expect(Object.keys(first.document.edges[0]!)).toEqual(['id', 'type', 'source', 'sourceHandle', 'target', 'targetHandle', 'data']);
	});

	test('a normalised valid workflow survives JSON unchanged', () => {
		const document = validWorkflow();
		const json = JSON.stringify(normalizeDocument(document).document);
		expect(json).toBe(JSON.stringify(document));
	});

	test('never throws, whatever it is given', () => {
		let seed = 7;
		const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

		const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

		const atoms: unknown[] = [
			null,
			undefined,
			0,
			-1,
			Number.NaN,
			Infinity,
			'',
			'x',
			'{',
			true,
			10n,
			Symbol('s'),
			() => 1,
			new Date(0),
			new Map(),
			Object.create(null),
		];

		const keys = ['format', 'version', 'nodes', 'edges', 'id', 'type', 'position', 'data', 'source', 'target', 'sourceHandle', 'targetHandle', 'x', 'y', 'zoom', 'meta', 'viewport', 'ruleset', '__proto__', 'constructor', '_user'];

		const generate = (depth: number): unknown => {
			const roll = random();
			if (depth > 4 || roll < 0.3) return pick(atoms);
			if (roll < 0.6) return Array.from({ length: Math.floor(random() * 4) }, () => generate(depth + 1));

			const object: Record<string, unknown> = {};
			for (let i = 0; i < 5; i++) Object.defineProperty(object, pick(keys), { value: generate(depth + 1), enumerable: true, configurable: true, writable: true });
			return object;
		};

		for (let i = 0; i < 3000; i++) {
			const raw = random() < 0.5 ? generate(0) : { format: 'directus-node-graph', version: 1, nodes: generate(1), edges: generate(1) };
			const result = normalizeDocument(raw);

			expect(Array.isArray(result.document.nodes)).toBe(true);
			expect(Array.isArray(result.document.edges)).toBe(true);
			expect(() => JSON.stringify(result.document)).not.toThrow();
		}

		const throwing = { format: 'directus-node-graph', version: 1, get nodes(): never { throw new Error('boom'); } };
		expect(normalizeDocument(throwing).fatal).toEqual(['The value could not be read.']);

		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		expect(() => normalizeDocument(proxy)).not.toThrow();
	});
});

describe('starterDocument', () => {
	test('seeds the ruleset starter with fresh ids, defaults and the stamp', () => {
		const document = starterDocument(example);

		expect(document.ruleset).toEqual({ key: 'approval-workflow', version: 1 });
		expect(document.nodes.map((item) => [item.type, item.position])).toEqual([
			['start', { x: 0, y: 0 }],
			['end', { x: 480, y: 0 }],
		]);

		expect(document.nodes.every((item) => /^n_[0-9a-z]{12}$/.test(item.id))).toBe(true);
		expect(new Set(document.nodes.map((item) => item.id)).size).toBe(2);
		expect(document.edges).toEqual([]);
	});

	test('without a starter seeds minInstances of every non-deprecated type', () => {
		const ruleset = variant((copy) => {
			delete copy.starter;
			copy.nodeTypes.find((type) => type.key === 'legacy_review')!.limits = { minInstances: 2 };
			copy.nodeTypes.find((type) => type.key === 'task')!.limits = { minInstances: 1 };
		});

		const document = starterDocument(ruleset);

		expect(document.nodes.map((item) => item.type)).toEqual(['start', 'task', 'end']);
		expect(document.nodes.map((item) => item.position.x)).toEqual([0, 360, 720]);
		expect(document.nodes[1]!.data).toEqual({ due_days: 3 });
	});

	test('seeds starter edges with the port default type and field defaults', () => {
		const ruleset = variant((copy) => {
			copy.starter = {
				nodes: [
					{ ref: 's', type: 'start', position: { x: 0, y: 0 } },
					{ ref: 't', type: 'task', position: { x: 240, y: 0 }, data: { title: 'First' } },
				],
				edges: [{ source: 's', sourceHandle: 'next', target: 't', targetHandle: 'in' }],
			};
		});

		const document = starterDocument(ruleset);

		expect(document.nodes[1]!.data).toEqual({ due_days: 3, title: 'First' });
		expect(document.edges).toHaveLength(1);
		expect(document.edges[0]).toMatchObject({ type: 'flow', source: document.nodes[0]!.id, target: document.nodes[1]!.id, data: {} });
	});
});
