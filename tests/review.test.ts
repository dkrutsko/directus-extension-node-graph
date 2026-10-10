/**
 * Regression tests from an adversarial review of the core and the hook. Each
 * describe block names one behaviour the review fixed (agreement between
 * canConnect and validateDocument, reserved ids, bounded messages, the
 * field-map cache on SQLite, and so on), so a failure points straight at it.
 */

import { isDirectusError } from '@directus/errors';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	applyCommand,
	canConnect,
	compileRuleset,
	exampleRuleset,
	formatValue,
	getPorts,
	normalizeDocument,
	renderTemplate,
	validateDocument,
	validateValue,
} from '../src/shared/core';
import type { CompiledRuleset, Connection, GraphCommand, GraphDocument, Ruleset } from '../src/shared/core';
import { truncate } from '../src/shared/core/util';
import type { fakeDatabase } from './fake-knex';
import { guardSetup } from './guard-setup';
import { doc, edge, example, node, validWorkflow, variant } from './helpers';

const connect = (from: string, to: string, type?: string): Connection => {
	const [source, ...sourceHandle] = from.split('.');
	const [target, ...targetHandle] = to.split('.');
	const connection: Connection = { source: source!, sourceHandle: sourceHandle.join('.'), target: target!, targetHandle: targetHandle.join('.') };
	if (type !== undefined) connection.type = type;
	return connection;
};

/** Error fingerprints of a document. */
const errorFingerprints = (ruleset: CompiledRuleset, document: GraphDocument) =>
	new Set(validateDocument(ruleset, document).filter((issue) => issue.severity === 'error').map((issue) => issue.fingerprint));

/** Every connection between every output and input of `document`, with and without an explicit edge type. */
function everyConnection(ruleset: CompiledRuleset, document: GraphDocument): Connection[] {
	const connections: Connection[] = [];

	for (const source of document.nodes) {
		for (const target of document.nodes) {
			for (const output of getPorts(ruleset, source).outputs) {
				for (const input of getPorts(ruleset, target).inputs) {
					for (const type of [undefined, 'flow', 'timeout']) {
						const connection: Connection = { source: source.id, sourceHandle: output.key, target: target.id, targetHandle: input.key };
						if (type !== undefined) connection.type = type;
						connections.push(connection);
					}
				}
			}
		}
	}

	return connections;
}

/**
 * The live check and the save check agree: canConnect accepts a connection
 * exactly when adding it as an edge introduces no new error.
 */
function expectAgreement(ruleset: CompiledRuleset, document: GraphDocument) {
	const before = errorFingerprints(ruleset, document);
	const disagreements: string[] = [];

	for (const connection of everyConnection(ruleset, document)) {
		const result = canConnect(ruleset, document, connection);

		// The type the edge would be stored with: what canConnect resolved, else what was asked for or the port default.
		const source = document.nodes.find((item) => item.id === connection.source)!;
		const portDefault = getPorts(ruleset, source).outputs.find((port) => port.key === connection.sourceHandle)!.edgeTypes[0]!;
		const type = result.ok ? result.type : (connection.type ?? portDefault);

		const { source: from, sourceHandle, target: to, targetHandle } = connection;
		const probe: GraphDocument = { ...document, edges: [...document.edges, { id: 'probe', type, source: from, sourceHandle, target: to, targetHandle }] };
		const added = [...errorFingerprints(ruleset, probe)].filter((fingerprint) => !before.has(fingerprint));

		if (result.ok && added.length > 0) disagreements.push(`accepted live, rejected on save: ${JSON.stringify(connection)} → ${added.join(' ')}`);
		if (!result.ok && added.length === 0) disagreements.push(`refused live (${result.code}), accepted on save: ${JSON.stringify(connection)}`);
	}

	expect(disagreements).toEqual([]);
}

const sample = () =>
	doc(
		[
			node('s', 'start'),
			node('t1', 'task', { title: 'One' }),
			node('t2', 'task', { title: 'Two' }),
			node('a', 'approval', { approver: 'manager' }),
			node('c', 'condition', { label: 'Route', branches: [{ label: 'Left' }, { label: 'Right' }] }),
			node('n', 'notify', { channel: 'email' }),
			node('end', 'end'),
		],
		[edge('e1', 's.next', 't1.in', 'flow'), edge('e2', 't1.next', 't2.in', 'flow'), edge('e3', 't2.next', 'a.in', 'flow'), edge('e4', 'a.escalate', 'n.trigger', 'flow')],
	);

describe('canConnect honours severity overrides, so it agrees with validateDocument', () => {
	test('a rule turned off or down to a warning no longer blocks the connection', () => {
		const relaxed = variant((ruleset) => {
			ruleset.severity = { type_mismatch: 'off', max_connections: 'warning', pair_not_allowed: 'off', self_loop: 'warning' };
		});

		const document = sample();

		expect(canConnect(example, document, connect('a.escalate', 't1.in'))).toMatchObject({ ok: false, code: 'type_mismatch' });
		expect(canConnect(relaxed, document, connect('a.escalate', 't1.in'))).toEqual({ ok: true, type: 'flow' });
		expect(canConnect(relaxed, document, connect('s.next', 't2.in'))).toEqual({ ok: true, type: 'flow' });
		expect(canConnect(relaxed, document, connect('s.next', 'end.in'))).toEqual({ ok: true, type: 'flow' });
		expect(canConnect(relaxed, document, connect('n.next', 'n.in'))).toEqual({ ok: true, type: 'flow' });

		// What applyCommand then adds is a warning (or nothing), never an error.
		const next = applyCommand(relaxed, document, { kind: 'addEdge', ...connect('s.next', 't2.in'), id: 'extra' });
		expect(next.edges.map((item) => item.id)).toContain('extra');
		expect(validateDocument(relaxed, next).filter((issue) => issue.code === 'max_connections').map((issue) => issue.severity)).toEqual(['warning']);
	});

	test('addNode applies the same rule to limits.maxInstances', () => {
		const softLimit = variant((ruleset) => {
			ruleset.severity = { max_instances: 'warning' };
		});

		const document = sample();
		const addStart: GraphCommand = { kind: 'addNode', type: 'start', position: { x: 0, y: 0 }, id: 's2' };

		expect(applyCommand(example, document, addStart)).toBe(document);

		const next = applyCommand(softLimit, document, addStart);
		expect(next.nodes.map((item) => item.id)).toContain('s2');
		expect(validateDocument(softLimit, next).filter((issue) => issue.code === 'max_instances').map((issue) => issue.severity)).toEqual(['warning']);
	});

	test('structural problems are refused whatever their severity', () => {
		const lenient = variant((ruleset) => {
			ruleset.severity = { unknown_port: 'off', wrong_direction: 'off', unknown_edge_type: 'off', dangling_edge: 'off' };
		});

		const document = sample();
		expect(canConnect(lenient, document, connect('t1.nope', 't2.in'))).toMatchObject({ ok: false, code: 'unknown_port' });
		expect(canConnect(lenient, document, connect('t1.in', 't2.in'))).toMatchObject({ ok: false, code: 'wrong_direction' });
		expect(canConnect(lenient, document, connect('t1.next', 'a.in', 'warp'))).toMatchObject({ ok: false, code: 'unknown_edge_type' });
		expect(canConnect(lenient, document, connect('ghost.next', 'a.in'))).toMatchObject({ ok: false, code: 'dangling_edge' });
	});

	test('exhaustively: accepted live ⇔ no new error on save, across rule switches and severities', () => {
		const rulesets: CompiledRuleset[] = [
			example,
			variant((ruleset) => {
				ruleset.connectionRules!.allowCycles = false;
			}),
			variant((ruleset) => {
				ruleset.connectionRules = { ...ruleset.connectionRules, allowSelfLoops: true, allowMultiEdges: true, allowCycles: false, typeCheck: 'off' };
			}),
			variant((ruleset) => {
				ruleset.connectionRules!.pairs = { mode: 'allow', rules: [{ source: 'task' }, { target: 'end' }, { sourcePort: 'branches.*' }] };
			}),
			variant((ruleset) => {
				ruleset.connectionRules!.allowCycles = false;
				ruleset.severity = { max_connections: 'warning', cycle: 'off', multi_edge: 'warning', edge_type_not_allowed: 'off', self_loop: 'warning' };
			}),
		];

		for (const ruleset of rulesets) expectAgreement(ruleset, sample());
	});
});

describe('canConnect reports wrong_direction only when the missing end names a port of the other direction', () => {
	test('a node with an input and an output of the same key still gets unknown_port for a bad target', () => {
		// Port keys are unique per direction, so a task may have an input "next" as well as its output "next".
		const ruleset = variant((copy) => {
			copy.nodeTypes.find((type) => type.key === 'task')!.inputs!.push({ key: 'next', label: 'Back in', dataType: 'flow' });
		});

		const document = doc([node('t', 'task', { title: 'T' }), node('u', 'task', { title: 'U' })]);

		expect(canConnect(ruleset, document, connect('t.next', 'u.nope'))).toEqual({ ok: false, code: 'unknown_port', message: '"U" has no input "nope".' });

		const saved = { ...document, edges: [edge('e', 't.next', 'u.nope', 'flow')] };
		expect(validateDocument(ruleset, saved).filter((issue) => issue.severity === 'error').map((issue) => issue.code)).toEqual(['unknown_port']);
	});
});

describe('ids, endpoints and port keys that name Object.prototype members are not usable', () => {
	afterEach(() => {
		for (const key of ['e_polluted', 'polluted']) delete (Object.prototype as Record<string, unknown>)[key];
	});

	test('normalizeDocument removes such nodes and edges as fatal and clears such handles', () => {
		const json = JSON.stringify({
			format: 'directus-node-graph',
			version: 1,
			nodes: [
				{ id: 'ok', type: 'task', position: { x: 0, y: 0 }, data: { title: 'A' } },
				{ id: '__proto__', type: 'task', position: { x: 0, y: 0 }, data: {} },
				{ id: 'constructor', type: 'task', position: { x: 0, y: 0 }, data: {} },
				{ id: 'toString', type: 'task', position: { x: 0, y: 0 }, data: {} },
			],
			edges: [
				{ id: 'e_polluted', source: '__proto__', sourceHandle: 'next', target: 'ok', targetHandle: 'in' },
				{ id: 'keys', source: 'constructor', sourceHandle: 'next', target: 'ok', targetHandle: 'in' },
				{ id: 'valueOf', source: 'ok', sourceHandle: 'next', target: 'ok', targetHandle: 'in' },
				{ id: 'h', source: 'ok', sourceHandle: '__proto__', target: 'ok', targetHandle: 'hasOwnProperty' },
			],
		});

		const result = normalizeDocument(json);

		expect(result.document.nodes.map((item) => item.id)).toEqual(['ok']);
		expect(result.document.edges).toEqual([{ id: 'h', source: 'ok', sourceHandle: '', target: 'ok', targetHandle: '' }]);
		expect(result.fatal).toEqual([
			'nodes[1]: no usable id; the node was removed.',
			'nodes[2]: no usable id; the node was removed.',
			'nodes[3]: no usable id; the node was removed.',
			'Connection e_polluted: the source or target is missing or not a usable id; the connection was removed.',
			'Connection keys: the source or target is missing or not a usable id; the connection was removed.',
			'edges[2]: no usable id; the connection was removed.',
			'Connection h: the sourceHandle "__proto__" is not allowed and was cleared.',
			'Connection h: the targetHandle "hasOwnProperty" is not allowed and was cleared.',
		]);

		expect(validateValue(example, json).issues.filter((issue) => issue.code === 'invalid_document')).toHaveLength(8);
		expect(({} as Record<string, unknown>)['e_polluted']).toBeUndefined();
		expect(typeof Object.keys).toBe('function');
	});

	test('applyCommand refuses node and edge ids normalizeDocument would not keep', () => {
		const document = doc([node('s', 'start'), node('t', 'task', { title: 'T' })]);
		const addNode = (id: string): GraphCommand => ({ kind: 'addNode', type: 'task', position: { x: 0, y: 0 }, id });
		const addEdge = (id: string): GraphCommand => ({ kind: 'addEdge', ...connect('s.next', 't.in'), id });

		for (const id of ['', '__proto__', 'constructor', 'toString', 'x'.repeat(201)]) {
			expect(applyCommand(example, document, addNode(id))).toBe(document);
			expect(applyCommand(example, document, addEdge(id))).toBe(document);
		}

		// Whatever applyCommand adds survives a round trip through normalizeDocument.
		const added = applyCommand(example, applyCommand(example, document, addNode('n_ok')), addEdge('e_ok'));
		expect(normalizeDocument(JSON.parse(JSON.stringify(added))).document).toEqual(added);
	});

	test('compileRuleset rejects reserved type, port and field keys', () => {
		const raw = JSON.parse(JSON.stringify(exampleRuleset)) as Ruleset;
		raw.nodeTypes[1]!.key = 'toString';
		raw.nodeTypes[2]!.outputs![0]!.key = 'valueOf';
		raw.nodeTypes[3]!.fields!.push({ field: 'hasOwnProperty', type: 'string' });
		raw.edgeTypes![1]!.key = 'constructor';

		const { ruleset, problems } = compileRuleset(raw);

		expect(ruleset).toBeNull();
		expect(problems).toEqual(
			expect.arrayContaining([
				'nodeTypes[1].key: "toString" is a reserved name.',
				'nodeTypes[2].outputs[0].key: "valueOf" is a reserved name.',
				'nodeTypes[3].fields[2].field: "hasOwnProperty" is not an allowed field key.',
				'edgeTypes[1].key: "constructor" is a reserved name.',
			]),
		);
	});
});

describe('non-text types and port keys are kept as text when they are numbers, and are fatal otherwise', () => {
	test('numbers become keys, objects are reported as lost data', () => {
		const raw = doc(
			[{ id: 'a', type: 5, position: { x: 0, y: 0 }, data: {} } as never, { id: 'b', type: { key: 'task' }, position: { x: 0, y: 0 }, data: {} } as never],
			[{ id: 'e', type: ['flow'], source: 'a', sourceHandle: 0, target: 'b', targetHandle: { key: 'in' } } as never],
		);

		const result = normalizeDocument(raw);

		expect(result.document.nodes.map((item) => item.type)).toEqual(['5', '']);
		expect(result.document.edges).toEqual([{ id: 'e', source: 'a', sourceHandle: '0', target: 'b', targetHandle: '' }]);
		expect(result.fatal).toEqual([
			'Node b: the type is not text; it was cleared.',
			'Connection e: the targetHandle is not text; it was cleared.',
			'Connection e: the type is not text; it was removed.',
		]);

		expect(result.problems).toEqual(
			expect.arrayContaining(['Node a: the numeric type was converted to text.', 'Connection e: the numeric sourceHandle was converted to text.']),
		);
	});

	test('random messy values normalise to a fixed point (byte-stable, no further repairs, same hash)', () => {
		let seed = 99;
		const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

		const atoms: unknown[] = [null, 0, 5, -1.5, '', 'x', 'next', 'in', 'task', 'flow', true, '__proto__', 'toString', 'constructor', '_user'];
		const keys = ['id', 'type', 'position', 'data', 'source', 'target', 'sourceHandle', 'targetHandle', 'x', 'y', 'zoom', 'title', '_user', 'branches', 'extra'];

		const generate = (depth: number): unknown => {
			const roll = random();
			if (depth > 4 || roll < 0.35) return pick(atoms);
			if (roll < 0.55) return Array.from({ length: Math.floor(random() * 4) }, () => generate(depth + 1));

			const object: Record<string, unknown> = {};
			for (let i = 0; i < 5; i++) object[pick(keys)] = generate(depth + 1);
			return object;
		};

		for (let i = 0; i < 2000; i++) {
			const json = JSON.stringify({ format: 'directus-node-graph', version: 1, nodes: [generate(1), generate(1)], edges: [generate(1), generate(1)], viewport: generate(1) });
			const first = JSON.stringify(normalizeDocument(json).document);
			const second = normalizeDocument(first);

			expect(second.problems).toEqual([]);
			expect(JSON.stringify(second.document)).toBe(first);
		}
	});
});

describe('renderTemplate and formatValue survive cyclic and absurdly deep lists', () => {
	test('no stack overflow; ordinary nesting still renders', () => {
		const cyclic: unknown[] = ['a'];
		cyclic.push(cyclic);

		let deep: unknown = 'bottom';
		for (let i = 0; i < 20_000; i++) deep = [deep];

		expect(() => renderTemplate('{{ list }}', { list: cyclic })).not.toThrow();
		expect(renderTemplate('{{ list }}', { list: cyclic })).toMatch(/^a(, a)*$/);
		expect(renderTemplate('{{ list }}', { list: deep })).toBe('');
		expect(formatValue(['a', ['b', ['c']], null, true])).toBe('a, b, c, Yes');
	});
});

describe('updateNodeData and updateEdge return the same document when nothing changes', () => {
	test('repeating current values is a no-op; real changes still apply', () => {
		const document = validWorkflow();

		expect(applyCommand(example, document, { kind: 'updateNodeData', id: 't', data: { title: 'Prepare access', due_days: 2 } })).toBe(document);
		expect(applyCommand(example, document, { kind: 'updateNodeData', id: 'c', data: { branches: [{ label: 'Production' }, { label: 'Staging' }] } })).toBe(document);
		expect(applyCommand(example, document, { kind: 'updateEdge', id: 'e5', data: { label: 'prod' } })).toBe(document);
		expect(applyCommand(example, document, { kind: 'updateEdge', id: 'e2', type: 'timeout', data: { after_hours: 48 } })).toBe(document);

		const renamed = applyCommand(example, document, { kind: 'updateNodeData', id: 't', data: { title: 'Prepare access', due_days: 5 } });
		expect(renamed).not.toBe(document);
		expect(renamed.nodes.find((item) => item.id === 't')!.data).toEqual({ title: 'Prepare access', assignee: 'it', due_days: 5 });

		// A key the node does not have yet is a change, even to null: it changes the stored JSON.
		const cleared = applyCommand(example, document, { kind: 'updateNodeData', id: 's', data: { note: null } });
		expect(cleared.nodes.find((item) => item.id === 's')!.data).toEqual({ title: 'Request received', note: null });
	});
});

describe('updateEdge judges the edge type on the source port, even for an edge that is invalid for another reason', () => {
	test('a self loop on "Approved" cannot become a Timeout connection', () => {
		const document = doc([node('a', 'approval', { approver: 'manager' })], [edge('loop', 'a.approved', 'a.in', 'flow')]);

		expect(applyCommand(example, document, { kind: 'updateEdge', id: 'loop', type: 'timeout' })).toBe(document);

		// Allowed ports still change, and an unresolvable port has no list to judge against.
		const task = doc([node('t', 'task', { title: 'T' })], [edge('loop', 't.next', 't.in', 'flow'), edge('lost', 't.gone', 't.in', 'flow')]);
		expect(applyCommand(example, task, { kind: 'updateEdge', id: 'loop', type: 'timeout' }).edges[0]!.type).toBe('timeout');
		expect(applyCommand(example, task, { kind: 'updateEdge', id: 'lost', type: 'timeout' }).edges[1]!.type).toBe('timeout');

		// With the rule off, any known type goes.
		const relaxed = variant((ruleset) => {
			ruleset.severity = { edge_type_not_allowed: 'off' };
		});

		expect(applyCommand(relaxed, document, { kind: 'updateEdge', id: 'loop', type: 'timeout' }).edges[0]!.type).toBe('timeout');
	});
});

describe('applyCommand ignores a missing command', () => {
	test('null and undefined return the document', () => {
		const document = validWorkflow();
		expect(applyCommand(example, document, null as unknown as GraphCommand)).toBe(document);
		expect(applyCommand(example, document, undefined as unknown as GraphCommand)).toBe(document);
	});
});

describe('compileRuleset rejects a starter graph that would be seeded with errors', () => {
	const withStarter = (change: (ruleset: Ruleset) => void) => {
		const raw = JSON.parse(JSON.stringify(exampleRuleset)) as Ruleset;
		change(raw);
		return compileRuleset(raw);
	};

	test('starter edges must pass canConnect and starter types must respect maxInstances', () => {
		const denied = withStarter((ruleset) => {
			ruleset.starter!.edges = [{ source: 'start', sourceHandle: 'next', target: 'end', targetHandle: 'in' }];
		});

		expect(denied.ruleset).toBeNull();
		expect(denied.problems).toEqual(['starter.edges[0]: Start cannot go straight to End.']);

		const twice = withStarter((ruleset) => {
			ruleset.starter!.nodes.push(
				{ ref: 'task', type: 'task', position: { x: 240, y: 0 }, data: { title: 'T' } },
				{ ref: 'other', type: 'task', position: { x: 240, y: 120 }, data: { title: 'U' } },
			);

			ruleset.starter!.edges = [
				{ source: 'start', sourceHandle: 'next', target: 'task', targetHandle: 'in' },
				{ source: 'start', sourceHandle: 'next', target: 'other', targetHandle: 'in' },
			];
		});

		// The second edge is judged against the first: Start's output takes one connection.
		expect(twice.problems).toEqual(['starter.edges[1]: output "Next" already has 1 connection (at most 1).']);

		const twoStarts = withStarter((ruleset) => {
			ruleset.starter!.nodes.push({ ref: 'start2', type: 'start', position: { x: 0, y: 240 } });
		});

		expect(twoStarts.problems).toEqual(['starter.nodes: has 2 "start" nodes, but at most 1 is allowed.']);
	});

	test('a valid starter with edges still compiles, and downgraded rules are respected', () => {
		const chain = withStarter((ruleset) => {
			ruleset.starter!.nodes.push({ ref: 'task', type: 'task', position: { x: 240, y: 0 }, data: { title: 'T' } });
			ruleset.starter!.edges = [
				{ source: 'start', sourceHandle: 'next', target: 'task', targetHandle: 'in' },
				{ source: 'task', sourceHandle: 'next', target: 'end', targetHandle: 'in', type: 'timeout' },
			];
		});

		expect(chain.problems).toEqual([]);

		const relaxed = withStarter((ruleset) => {
			ruleset.severity = { pair_not_allowed: 'warning' };
			ruleset.starter!.edges = [{ source: 'start', sourceHandle: 'next', target: 'end', targetHandle: 'in' }];
		});

		expect(relaxed.problems).toEqual([]);
	});
});

describe('messages never echo an unbounded untrusted string', () => {
	test('port keys, type keys and format markers are shortened', () => {
		const long = 'x'.repeat(100_000);
		const document = doc([node('t', 'task', { title: 'T' }), node('u', long.slice(0, 150), {})], [edge('e', `t.${long}`, 'u.in', long)]);

		const messages = validateDocument(example, document).map((issue) => issue.message);
		expect(Math.max(...messages.map((message) => message.length))).toBeLessThan(250);

		expect(normalizeDocument({ format: long, nodes: [] }).fatal[0]!.length).toBeLessThan(150);
		expect((canConnect(example, document, connect(`t.${long}`, 'u.in')) as { message: string }).message.length).toBeLessThan(250);
	});

	test('truncate stays correct on huge strings and surrogate pairs', () => {
		expect(truncate('ab', 2)).toBe('ab');
		expect(truncate('abc', 2)).toBe('a…');
		expect(truncate('😀😀😀', 3)).toBe('😀😀😀');
		expect(truncate('😀😀😀😀', 3)).toBe('😀😀…');
		expect(truncate('y'.repeat(5_000_000), 4)).toBe('yyy…');
	});
});

/* ------------------------------------------------------------------------ */
/* Hook                                                                     */
/* ------------------------------------------------------------------------ */

const fieldQueries = (db: ReturnType<typeof fakeDatabase>) => db.queries.filter((table) => table === 'directus_fields').length;

describe('the hook never stores a lossy copy, even when invalid_document is turned off', () => {
	test('a value normalisation could only keep by dropping data is left untouched', async () => {
		const { create } = guardSetup({ ruleset: { ...exampleRuleset, severity: { invalid_document: 'off' } } });
		const polluted = JSON.parse(JSON.stringify(validWorkflow()).replace('"title":"Request received"', '"title":"Request received","__proto__":{"x":1}'));
		polluted.nodes.push({ type: 'task', data: { title: 'No id, but someone typed this' } });

		const result = await create({ graph: polluted });
		expect(result.graph).toBe(polluted);

		// A clean value is still normalised and stamped.
		expect((await create({ graph: validWorkflow() })).graph.meta.nodeCount).toBe(7);
	});
});

describe('the field map is never shared across database handles, and clear() drops loads in flight', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test('a create inside its transaction does not wait for a load stuck on the busy root connection (SQLite)', async () => {
		const { root, trx, create, update } = guardSetup();

		// The create's transaction holds SQLite's only connection, so root queries wait.
		root.hold();
		const pendingUpdate = update({ graph: validWorkflow() });
		const created = create({ graph: validWorkflow() });

		const outcome = await Promise.race([created.then(() => 'created'), new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 100))]);
		expect(outcome).toBe('created');
		expect(fieldQueries(trx)).toBe(1);

		root.release();
		expect((await pendingUpdate).graph.meta.nodeCount).toBe(7);
	});

	test('callers after a field change start a fresh load instead of joining the stale one', async () => {
		const { root, update, clear } = guardSetup();

		root.hold();
		const first = update({ graph: validWorkflow() });
		clear();
		const second = update({ graph: validWorkflow() });
		root.release();

		await Promise.all([first, second]);
		expect(fieldQueries(root)).toBe(2);
	});

	test('the map is cached for 60 s and reloaded after', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(0);

		const { trx, create } = guardSetup();
		await create({ graph: validWorkflow() });
		vi.setSystemTime(59_000);
		await create({ graph: validWorkflow() });
		expect(fieldQueries(trx)).toBe(1);

		vi.setSystemTime(60_001);
		await create({ graph: validWorkflow() });
		expect(fieldQueries(trx)).toBe(2);
	});
});

describe('the hook stays correct and fast on bulk updates and large graphs (call counts are in review-spies.test.ts)', () => {
	/** 500 notify nodes and 1,000 edges (two per output, never a self loop), free of errors under largeRuleset. */
	function largeGraph(): GraphDocument {
		const nodes = Array.from({ length: 500 }, (_, i) => node(`n${i}`, 'notify', { channel: 'email', message: `Step ${i}` }));
		const edges = Array.from({ length: 1000 }, (_, i) => edge(`e${i}`, `n${i % 500}.next`, `n${(i * 7 + 1) % 500}.${i % 2 ? 'in' : 'trigger'}`, 'flow'));
		return doc(nodes, edges);
	}

	// The example with an unlimited notify output, no type check and room for the graph's size.
	const largeRuleset = {
		...exampleRuleset,
		nodeTypes: exampleRuleset.nodeTypes.map((type) =>
			type.key === 'notify' ? { ...type, outputs: [{ key: 'next', label: 'Next', dataType: 'flow', edgeTypes: ['flow'] }] } : type,
		),
		connectionRules: { ...exampleRuleset.connectionRules, typeCheck: 'off' as const, allowMultiEdges: true },
		graphRules: { maxNodes: 1000, maxEdges: 2000 },
	};

	test('a bulk update over many items holding the same broken graph keeps its pre-existing error', async () => {
		// One pre-existing error (a task without a title), stored on 1,500 items, as text (SQLite).
		const broken = doc([...validWorkflow().nodes, node('t9', 'task', {})], validWorkflow().edges);
		const items = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, graph: JSON.stringify(broken) }));
		const { update } = guardSetup({}, [], items);
		const keys = items.map((item) => item.id);

		const started = performance.now();
		const result = await update({ graph: broken }, keys);
		expect(result.graph.meta.errorCount).toBe(1);
		expect(performance.now() - started).toBeLessThan(2000);

		// One item without that error is enough to reject it as new.
		items[700]!.graph = JSON.stringify(validWorkflow());
		expect(isDirectusError(await update({ graph: broken }, keys).catch((caught: unknown) => caught))).toBe(true);
	});

	test('create and ratchet update of a 500-node, 1,000-edge graph', async () => {
		const graph = largeGraph();
		const { create, update } = guardSetup({ ruleset: largeRuleset }, [], [{ id: 1, graph: JSON.stringify(graph) }]);

		const started = performance.now();
		const created = await create({ graph });
		expect(created.graph.meta).toMatchObject({ nodeCount: 500, edgeCount: 1000, errorCount: 0 });

		// An update that adds a self loop is judged against the stored graph and rejected.
		const worse = { ...graph, edges: [...graph.edges, edge('loop', 'n1.next', 'n1.in', 'flow')] };
		const error = await update({ graph: worse }).catch((caught: unknown) => caught);
		expect((error as { extensions: { issues: unknown[] } }).extensions.issues).toEqual([{ code: 'self_loop', edgeId: 'loop', nodeId: 'n1' }]);

		expect(performance.now() - started).toBeLessThan(1500);
	});
});

describe('the ruleset check also covers fields created with their collection, and never fails unmanaged field saves', () => {
	const broken = { key: 'x', nodeTypes: [] };

	test('flat directus_fields rows (POST /collections with fields) are checked', async () => {
		const { filters, context, root } = guardSetup();
		const create = filters.get('fields.create')!;
		const meta = { event: 'fields.create', collection: 'directus_fields' };

		const row = (ruleset: unknown, iface = 'node-graph-test') => ({ collection: 'graph_new', field: 'graph', interface: iface, options: { ruleset } });

		const error = await create(row(broken), meta, context(root)).catch((caught: unknown) => caught);
		expect(isDirectusError(error, 'INVALID_PAYLOAD')).toBe(true);
		expect((error as Error).message).toContain('The node graph ruleset of "graph" has 1 problem');

		const asText = { ...row(null), options: JSON.stringify({ ruleset: broken }) };
		expect(isDirectusError(await create(asText, meta, context(root)).catch((caught: unknown) => caught))).toBe(true);

		for (const payload of [row(exampleRuleset), row(broken, 'input-code'), row(null)]) {
			expect(await create(payload, meta, context(root))).toBe(payload);
		}
	});

	test('a flat options-only update is checked against the stored row', async () => {
		const { filters, context, root } = guardSetup();
		const payload = { options: { ruleset: broken } };

		const error = await filters.get('fields.update')!(payload, { event: 'fields.update', collection: 'directus_fields', keys: [1] }, context(root)).catch((caught: unknown) => caught);
		expect(isDirectusError(error, 'INVALID_PAYLOAD')).toBe(true);

		expect(await filters.get('fields.update')!(payload, { event: 'fields.update', collection: 'directus_fields', keys: [2] }, context(root))).toBe(payload);
	});

	test('a failing stored-interface lookup lets the field save through and logs it', async () => {
		const { filters, context, root, logger } = guardSetup();
		const payload = { field: 'title', meta: { options: { anything: true } } };

		root.fail();
		expect(await filters.get('fields.update')!(payload, { event: 'fields.update', collection: 'graph_test', keys: ['title'] }, context(root))).toBe(payload);
		expect(logger.error).toHaveBeenCalled();
	});
});
