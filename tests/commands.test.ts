import { describe, expect, test } from 'vitest';
import { applyCommand, graphHash, starterDocument, validateDocument } from '../src/shared/core';
import type { GraphCommand, GraphDocument } from '../src/shared/core';
import { doc, edge, example, node, validWorkflow } from './helpers';

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}

	return value;
}

describe('applyCommand', () => {
	test('never mutates its input (every command, frozen input)', () => {
		const document = deepFreeze(validWorkflow());
		const before = JSON.stringify(document);

		const commands: GraphCommand[] = [
			{ kind: 'addNode', type: 'task', position: { x: 1, y: 2 }, data: { title: 'New' } },
			{ kind: 'moveNodes', moves: [{ id: 't', position: { x: 9, y: 9 } }], final: false },
			{ kind: 'removeElements', nodeIds: ['t'], edgeIds: ['e9'] },
			{ kind: 'addEdge', source: 'c', sourceHandle: 'else', target: 'ok', targetHandle: 'in' },
			{ kind: 'reconnectEdge', id: 'e8', source: 'n', sourceHandle: 'next', target: 'no', targetHandle: 'in' },
			{ kind: 'updateNodeData', id: 't', data: { title: 'Renamed' } },
			{ kind: 'updateEdge', id: 'e5', data: { label: 'changed' } },
			{ kind: 'setViewport', viewport: { x: 1, y: 2, zoom: 1.5 } },
		];

		for (const command of commands) {
			expect(() => applyCommand(example, document, command)).not.toThrow();
		}

		expect(JSON.stringify(document)).toBe(before);
	});

	describe('addNode', () => {
		test('fills field defaults, merges data and generates an id', () => {
			const next = applyCommand(example, doc([]), { kind: 'addNode', type: 'task', position: { x: 36, y: 54 }, data: { title: 'Check' } });

			expect(next.nodes).toHaveLength(1);
			expect(next.nodes[0]).toMatchObject({ type: 'task', position: { x: 36, y: 54 }, data: { due_days: 3, title: 'Check' } });
			expect(next.nodes[0]!.id).toMatch(/^n_[0-9a-z]{12}$/);

			const approval = applyCommand(example, doc([]), { kind: 'addNode', type: 'approval', position: { x: 0, y: 0 }, id: 'given' });
			expect(approval.nodes[0]).toEqual({ id: 'given', type: 'approval', position: { x: 0, y: 0 }, data: { sla_hours: 24 } });
		});

		test('defaults are copies, never shared between nodes', () => {
			const withObjectDefault = { ...example, nodeTypeMap: new Map(example.nodeTypeMap) };
			withObjectDefault.nodeTypeMap.set('task', {
				...example.nodeTypeMap.get('task')!,
				fields: [{ field: 'tags', type: 'json', schema: { default_value: ['a'] } }],
			});

			let document = doc([]);
			document = applyCommand(withObjectDefault, document, { kind: 'addNode', type: 'task', position: { x: 0, y: 0 } });
			document = applyCommand(withObjectDefault, document, { kind: 'addNode', type: 'task', position: { x: 0, y: 0 } });

			expect(document.nodes[0]!.data['tags']).toEqual(['a']);
			expect(document.nodes[0]!.data['tags']).not.toBe(document.nodes[1]!.data['tags']);
		});

		test('refuses unknown types, types at maxInstances, taken ids and bad positions', () => {
			const document = starterDocument(example);
			const takenId = document.nodes[0]!.id;

			expect(applyCommand(example, document, { kind: 'addNode', type: 'retired', position: { x: 0, y: 0 } })).toBe(document);
			expect(applyCommand(example, document, { kind: 'addNode', type: 'start', position: { x: 0, y: 0 } })).toBe(document);
			expect(applyCommand(example, document, { kind: 'addNode', type: 'task', position: { x: 0, y: 0 }, id: takenId })).toBe(document);
			expect(applyCommand(example, document, { kind: 'addNode', type: 'task', position: { x: Number.NaN, y: 0 } })).toBe(document);
		});

		test('drops forbidden and versioning keys from incoming data', () => {
			const data = JSON.parse('{"title":"A","__proto__":{"x":1},"_user":"u"}');
			const next = applyCommand(example, doc([]), { kind: 'addNode', type: 'task', position: { x: 0, y: 0 }, data });
			expect(next.nodes[0]!.data).toEqual({ due_days: 3, title: 'A' });
		});
	});

	describe('moveNodes', () => {
		test('moves nodes and keeps untouched nodes and the hash', () => {
			const document = validWorkflow();
			const next = applyCommand(example, document, { kind: 'moveNodes', moves: [{ id: 't', position: { x: 1, y: 1 } }], final: true });

			expect(next.nodes.find((item) => item.id === 't')!.position).toEqual({ x: 1, y: 1 });
			expect(next.nodes.find((item) => item.id === 's')).toBe(document.nodes.find((item) => item.id === 's'));
			expect(next.edges).toBe(document.edges);
			expect(graphHash(next)).toBe(graphHash(document));
		});

		test('returns the same document for a no-op, unknown ids or bad positions', () => {
			const document = validWorkflow();
			const same = document.nodes[0]!;

			expect(applyCommand(example, document, { kind: 'moveNodes', moves: [{ id: same.id, position: { ...same.position } }], final: true })).toBe(document);
			expect(applyCommand(example, document, { kind: 'moveNodes', moves: [{ id: 'missing', position: { x: 1, y: 1 } }], final: true })).toBe(document);
			expect(applyCommand(example, document, { kind: 'moveNodes', moves: [{ id: 't', position: { x: Infinity, y: 1 } }], final: true })).toBe(document);
		});
	});

	describe('removeElements', () => {
		test('removing a node removes its edges', () => {
			const next = applyCommand(example, validWorkflow(), { kind: 'removeElements', nodeIds: ['a'], edgeIds: [] });

			expect(next.nodes.map((item) => item.id)).not.toContain('a');
			expect(next.edges.map((item) => item.id)).toEqual(['e1', 'e5', 'e6', 'e7', 'e8']);
		});

		test('keeps nodes that are not deletable, removes unknown-type nodes', () => {
			const document = doc([node('s', 'start'), node('g', 'retired')], [edge('x', 's.next', 'g.in')]);
			const next = applyCommand(example, document, { kind: 'removeElements', nodeIds: ['s', 'g'], edgeIds: [] });

			expect(next.nodes.map((item) => item.id)).toEqual(['s']);
			expect(next.edges).toEqual([]);
			expect(applyCommand(example, next, { kind: 'removeElements', nodeIds: ['s'], edgeIds: ['nope'] })).toBe(next);
		});

		test('removes edges by id', () => {
			const next = applyCommand(example, validWorkflow(), { kind: 'removeElements', nodeIds: [], edgeIds: ['e9', 'e1'] });
			expect(next.edges.map((item) => item.id)).toEqual(['e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
		});
	});

	describe('addEdge', () => {
		test('adds a valid edge with the resolved type and that type’s field defaults', () => {
			const document = doc([node('s', 'start'), node('t', 'task', { title: 'T' })]);
			const next = applyCommand(example, document, { kind: 'addEdge', source: 's', sourceHandle: 'next', target: 't', targetHandle: 'in', id: 'e' });

			expect(next.edges).toEqual([{ id: 'e', type: 'flow', source: 's', sourceHandle: 'next', target: 't', targetHandle: 'in', data: {} }]);
		});

		test('returns the document unchanged when canConnect fails', () => {
			const document = starterDocument(example);
			const [start, end] = document.nodes;

			const next = applyCommand(example, document, {
				kind: 'addEdge',
				source: start!.id,
				sourceHandle: 'next',
				target: end!.id,
				targetHandle: 'in',
			});

			expect(next).toBe(document);
		});
	});

	describe('reconnectEdge', () => {
		test('moves the endpoints and keeps the type when allowed', () => {
			const next = applyCommand(example, validWorkflow(), { kind: 'reconnectEdge', id: 'e8', source: 'n', sourceHandle: 'next', target: 'no', targetHandle: 'in' });
			expect(next.edges.find((item) => item.id === 'e8')).toMatchObject({ source: 'n', target: 'no', type: 'flow' });
		});

		test('falls back to the new port’s default type when the old type is not allowed there', () => {
			const document = doc([node('t', 'task', { title: 'T' }), node('a', 'approval', { approver: 'manager' }), node('x', 'task', { title: 'X' })], [
				edge('e', 't.next', 'x.in', 'timeout', { after_hours: 4 }),
			]);

			const next = applyCommand(example, document, { kind: 'reconnectEdge', id: 'e', source: 'a', sourceHandle: 'approved', target: 'x', targetHandle: 'in' });
			expect(next.edges[0]).toMatchObject({ source: 'a', sourceHandle: 'approved', type: 'flow', data: { after_hours: 4 } });
		});

		test('refuses invalid reconnections and unknown edges', () => {
			const document = validWorkflow();
			expect(applyCommand(example, document, { kind: 'reconnectEdge', id: 'e1', source: 's', sourceHandle: 'next', target: 'ok', targetHandle: 'in' })).toBe(document);
			expect(applyCommand(example, document, { kind: 'reconnectEdge', id: 'nope', source: 's', sourceHandle: 'next', target: 't', targetHandle: 'in' })).toBe(document);
			expect(applyCommand(example, document, { kind: 'reconnectEdge', id: 'e1', source: 's', sourceHandle: 'next', target: 't', targetHandle: 'in' })).toBe(document);
		});
	});

	describe('updateNodeData', () => {
		test('shallow-merges data and clears with null', () => {
			const document = validWorkflow();
			const next = applyCommand(example, document, { kind: 'updateNodeData', id: 't', data: { title: 'Renamed', assignee: null } });

			expect(next.nodes.find((item) => item.id === 't')!.data).toEqual({ title: 'Renamed', assignee: null, due_days: 2 });
			expect(next.edges).toBe(document.edges);
		});

		test('returns the same document for an empty patch or an unknown node', () => {
			const document = validWorkflow();
			expect(applyCommand(example, document, { kind: 'updateNodeData', id: 't', data: {} })).toBe(document);
			expect(applyCommand(example, document, { kind: 'updateNodeData', id: 'nope', data: { a: 1 } })).toBe(document);
		});

		test('updating repeater items changes the dynamic outputs', () => {
			const next = applyCommand(example, validWorkflow(), {
				kind: 'updateNodeData',
				id: 'c',
				data: { branches: [{ label: 'Production' }] },
			});

			expect(validateDocument(example, next).map((issue) => [issue.code, issue.port])).toEqual([['unknown_port', 'branches.1']]);
		});
	});

	describe('updateEdge', () => {
		test('changes the type when the source port allows it and fills new defaults', () => {
			const document = validWorkflow();
			const next = applyCommand(example, document, { kind: 'updateEdge', id: 'e2', type: 'flow' });
			expect(next.edges.find((item) => item.id === 'e2')!.type).toBe('flow');

			const refused = applyCommand(example, document, { kind: 'updateEdge', id: 'e3', type: 'timeout' });
			expect(refused).toBe(document);

			const unknown = applyCommand(example, document, { kind: 'updateEdge', id: 'e3', type: 'warp' });
			expect(unknown).toBe(document);
		});

		test('merges data', () => {
			const next = applyCommand(example, validWorkflow(), { kind: 'updateEdge', id: 'e5', data: { label: 'production' } });
			expect(next.edges.find((item) => item.id === 'e5')!.data).toEqual({ label: 'production' });
		});
	});

	describe('setViewport', () => {
		test('sets the viewport, ignores invalid ones and does not affect the hash', () => {
			const document: GraphDocument = validWorkflow();
			const next = applyCommand(example, document, { kind: 'setViewport', viewport: { x: 5, y: 6, zoom: 0.75 } });

			expect(next.viewport).toEqual({ x: 5, y: 6, zoom: 0.75 });
			expect(graphHash(next)).toBe(graphHash(document));
			expect(applyCommand(example, next, { kind: 'setViewport', viewport: { x: 5, y: 6, zoom: 0.75 } })).toBe(next);
			expect(applyCommand(example, next, { kind: 'setViewport', viewport: { x: 5, y: 6, zoom: 0 } })).toBe(next);
		});
	});

	test('unknown command kinds return the document', () => {
		const document = validWorkflow();
		expect(applyCommand(example, document, { kind: 'teleport' } as unknown as GraphCommand)).toBe(document);
	});
});
