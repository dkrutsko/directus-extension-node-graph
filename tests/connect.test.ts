import { describe, expect, test } from 'vitest';
import { canConnect } from '../src/shared/core';
import type { Connection, ConnectResult } from '../src/shared/core';
import { doc, edge, example, node, validWorkflow, variant } from './helpers';

const connect = (from: string, to: string, type?: string): Connection => {
	const [source, ...sourceHandle] = from.split('.');
	const [target, ...targetHandle] = to.split('.');
	const connection: Connection = { source: source!, sourceHandle: sourceHandle.join('.'), target: target!, targetHandle: targetHandle.join('.') };
	if (type !== undefined) connection.type = type;
	return connection;
};

const open = () =>
	doc([
		node('s', 'start'),
		node('t1', 'task', { title: 'One' }),
		node('t2', 'task', { title: 'Two' }),
		node('a', 'approval', { approver: 'manager' }),
		node('c', 'condition', { label: 'Route', branches: [{ label: 'Left' }, { label: 'Right' }] }),
		node('n', 'notify', { channel: 'email' }),
		node('end', 'end'),
		node('ghost', 'retired'),
	]);

function code(result: ConnectResult): string {
	return result.ok ? `ok:${result.type}` : result.code;
}

describe('canConnect', () => {
	test('allows valid connections and resolves the edge type', () => {
		const document = open();

		expect(canConnect(example, document, connect('s.next', 't1.in'))).toEqual({ ok: true, type: 'flow' });
		expect(canConnect(example, document, connect('t1.next', 't2.in', 'timeout'))).toEqual({ ok: true, type: 'timeout' });
		expect(canConnect(example, document, connect('a.escalate', 'n.trigger'))).toEqual({ ok: true, type: 'flow' });
		expect(canConnect(example, document, connect('c.branches.1', 'n.in'))).toEqual({ ok: true, type: 'flow' });
	});

	test('rejects with the code and a readable message, one case per rule', () => {
		const document = doc(open().nodes, [edge('used', 's.next', 't1.in', 'flow'), edge('one', 't1.next', 'n.in', 'flow')]);

		const cases: Array<[Connection, string, string]> = [
			[connect('missing.next', 't1.in'), 'dangling_edge', 'One of the nodes no longer exists.'],
			[connect('ghost.out', 't1.in'), 'unknown_node_type', '"retired" has an unknown node type and cannot be connected.'],
			[connect('t1.in', 't2.in'), 'wrong_direction', 'Connections run from an output to an input.'],
			[connect('t2.next', 'a.approved'), 'wrong_direction', 'Connections run from an output to an input.'],
			[connect('t2.nope', 'a.in'), 'unknown_port', '"Two" has no output "nope".'],
			[connect('c.branches.7', 'a.in'), 'unknown_port', '"Route" has no output "branches.7".'],
			[connect('t2.next', 't2.in'), 'self_loop', 'A node cannot connect to itself.'],
			[connect('t2.next', 'a.in', 'warp'), 'unknown_edge_type', '"warp" is not a connection type of this ruleset.'],
			[connect('a.approved', 't2.in', 'timeout'), 'edge_type_not_allowed', 'output "Approved" does not allow "Timeout" connections.'],
			[connect('a.escalate', 't2.in'), 'type_mismatch', 'output "Escalate" (Event) cannot connect to input "In" (Control flow).'],
			[connect('s.next', 'end.in'), 'pair_not_allowed', 'Start cannot go straight to End.'],
			[connect('t1.next', 'n.in'), 'multi_edge', 'These ports are already connected.'],
			[connect('s.next', 't2.in'), 'max_connections', 'output "Next" already has 1 connection (at most 1).'],
		];

		for (const [connection, expectedCode, message] of cases) {
			expect(canConnect(example, document, connection)).toEqual({ ok: false, code: expectedCode, message });
		}
	});

	test('limits on the input side', () => {
		const ruleset = variant((copy) => {
			copy.nodeTypes.find((type) => type.key === 'end')!.inputs![0]!.maxConnections = 1;
		});

		const document = doc(open().nodes, [edge('x', 't1.next', 'end.in', 'flow')]);
		expect(canConnect(ruleset, document, connect('t2.next', 'end.in'))).toEqual({
			ok: false,
			code: 'max_connections',
			message: 'input "In" already has 1 connection (at most 1).',
		});
	});

	test('cycles only when forbidden, and only when the target already reaches the source', () => {
		const document = doc(open().nodes, [edge('x', 't1.next', 't2.in', 'flow'), edge('y', 't2.next', 'a.in', 'flow')]);
		const strict = variant((copy) => {
			copy.connectionRules!.allowCycles = false;
		});

		expect(code(canConnect(example, document, connect('a.rejected', 't1.in')))).toBe('ok:flow');
		expect(code(canConnect(strict, document, connect('a.rejected', 't1.in')))).toBe('cycle');
		expect(code(canConnect(strict, document, connect('a.rejected', 'n.in')))).toBe('ok:flow');
	});

	test('reconnecting an edge does not count the edge against itself', () => {
		const document = doc(open().nodes, [edge('x', 's.next', 't1.in', 'flow')]);

		expect(code(canConnect(example, document, connect('s.next', 't2.in')))).toBe('max_connections');
		expect(code(canConnect(example, document, connect('s.next', 't2.in'), { ignoreEdgeId: 'x' }))).toBe('ok:flow');
		expect(code(canConnect(example, document, connect('s.next', 't1.in'), { ignoreEdgeId: 'x' }))).toBe('ok:flow');

		const strict = variant((copy) => {
			copy.connectionRules!.allowCycles = false;
		});

		const loop = doc(open().nodes, [edge('x', 't1.next', 't2.in', 'flow'), edge('y', 't2.next', 'a.in', 'flow')]);
		expect(code(canConnect(strict, loop, connect('a.rejected', 't2.in'), { ignoreEdgeId: 'x' }))).toBe('cycle');
		expect(code(canConnect(strict, loop, connect('t2.next', 't1.in'), { ignoreEdgeId: 'y' }))).toBe('cycle');
	});

	test('rule switches: self loops, multi-edges and type checking can be turned off', () => {
		const relaxed = variant((copy) => {
			copy.connectionRules = { ...copy.connectionRules, allowSelfLoops: true, allowMultiEdges: true, typeCheck: 'off' };
		});

		const document = doc(open().nodes, [edge('one', 'n.next', 't1.in', 'flow')]);

		expect(code(canConnect(relaxed, document, connect('n.next', 'n.in')))).toBe('max_connections');
		expect(code(canConnect(relaxed, open(), connect('t1.next', 't1.in')))).toBe('ok:flow');
		expect(code(canConnect(relaxed, open(), connect('a.escalate', 't1.in')))).toBe('ok:flow');

		const multi = doc(open().nodes, [edge('one', 'a.escalate', 'n.trigger', 'flow')]);
		expect(code(canConnect(relaxed, multi, connect('a.escalate', 'n.trigger')))).toBe('ok:flow');
		expect(code(canConnect(example, multi, connect('a.escalate', 'n.trigger')))).toBe('multi_edge');
	});

	test('allow-mode pairs and `field.*` port patterns', () => {
		const allowOnly = variant((copy) => {
			copy.connectionRules!.pairs = { mode: 'allow', rules: [{ source: 'start', target: 'task' }, { source: 'condition', sourcePort: 'branches.*' }] };
		});

		expect(code(canConnect(allowOnly, open(), connect('s.next', 't1.in')))).toBe('ok:flow');
		expect(code(canConnect(allowOnly, open(), connect('c.branches.0', 'n.in')))).toBe('ok:flow');
		expect(code(canConnect(allowOnly, open(), connect('c.else', 'n.in')))).toBe('pair_not_allowed');
		expect(canConnect(allowOnly, open(), connect('t1.next', 'n.in'))).toMatchObject({ message: 'Task cannot connect to Notify.' });
	});

	test('works on the valid workflow without false positives', () => {
		const document = validWorkflow();
		document.nodes.push(node('t9', 'task', { title: 'New' }));
		expect(code(canConnect(example, document, connect('t9.next', 'ok.in')))).toBe('ok:flow');
	});
});
