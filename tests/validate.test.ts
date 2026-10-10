import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ISSUE_CODES, issueFingerprint, starterDocument, validateDocument, validateValue } from '../src/shared/core';
import type { GraphDocument, Issue, IssueCode } from '../src/shared/core';
import { codes, doc, edge, example, find, node, validWorkflow, variant } from './helpers';

const plantedJson = readFileSync(new URL('./fixtures/planted-faults.json', import.meta.url), 'utf8');

/**
 * The ruleset the planted-faults fixture is checked against: the example with
 * cycles forbidden, every node required to be connected, tight size caps and
 * one more deny pair, so that a single document can trip every rule.
 */
const plantedRuleset = variant((ruleset) => {
	ruleset.connectionRules!.allowCycles = false;
	ruleset.connectionRules!.pairs!.rules.push({ source: 'condition', sourcePort: 'else', target: 'notify', message: 'The fallback branch cannot notify.' });
	ruleset.graphRules = { ...ruleset.graphRules, requireConnected: true, maxNodes: 12, maxEdges: 10 };
});

/** Replaces a node or edge in the valid workflow. */
function withNode(id: string, change: Partial<GraphDocument['nodes'][number]>): GraphDocument {
	const base = validWorkflow();
	return { ...base, nodes: base.nodes.map((item) => (item.id === id ? { ...item, ...change } : item)) };
}

function withEdges(edges: GraphDocument['edges']): GraphDocument {
	const base = validWorkflow();
	return { ...base, edges: [...base.edges, ...edges] };
}

describe('validateDocument: the example ruleset, rule by rule', () => {
	test('a complete workflow has no issues', () => {
		expect(validateDocument(example, validWorkflow())).toEqual([]);
	});

	test('the starter graph has warnings only, so it can be saved', () => {
		const issues = validateDocument(example, starterDocument(example));

		expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
		expect(codes(issues).sort()).toEqual(['min_connections', 'min_connections', 'unreachable']);
		expect(issues.map((issue) => issue.message)).toEqual([
			'"Start": output "Next" needs at least 1 connection (has 0).',
			'"End": input "In" needs at least 1 connection (has 0).',
			'"End" cannot be reached from "Start".',
		]);
	});

	test('start: at most one (max_instances, error) and at least one (min_instances, warning)', () => {
		const two = { ...validWorkflow(), nodes: [...validWorkflow().nodes, node('s2', 'start')] };
		const tooMany = find(validateDocument(example, two), 'max_instances');

		expect(tooMany).toHaveLength(1);
		expect(tooMany[0]).toMatchObject({ severity: 'error', nodeId: 's2', message: 'Only 1 "Start" node is allowed (the graph has 2).' });

		const none = doc([node('t', 'task', { title: 'Orphan' })]);
		const issues = validateDocument(example, none);

		expect(find(issues, 'min_instances').map((issue) => issue.message)).toEqual([
			'The graph needs at least 1 "Start" node (it has 0).',
			'The graph needs at least 1 "End" node (it has 0).',
		]);

		// Without any entry node, reachability is reported once for the graph rather than per node.
		expect(find(issues, 'unreachable').map((issue) => issue.message)).toEqual(['The graph has no "Start" node to start from.']);
	});

	test('start.next: at least one connection, at most one', () => {
		const document = withEdges([edge('extra', 's.next', 'a.in', 'flow')]);
		const issues = find(validateDocument(example, document), 'max_connections');
		expect(issues.map((issue) => [issue.nodeId, issue.port, issue.message])).toEqual([
			['s', 'next', '"Request received": output "Next" allows at most 1 connection (has 2).'],
		]);
	});

	test('task.title is required (field_required, error) and names the field', () => {
		const issues = validateDocument(example, withNode('t', { data: { title: '', assignee: 'it' } }));
		expect(issues).toEqual([
			expect.objectContaining({ code: 'field_required', severity: 'error', nodeId: 't', field: 'title', message: '"Task": "Title" is required.' }),
		]);
	});

	test('approval.approver is required', () => {
		const issues = validateDocument(example, withNode('a', { data: { sla_hours: 24 } }));
		expect(codes(issues)).toEqual(['field_required']);
		expect(issues[0]!.message).toBe('"Approval": "Approver" is required.');
	});

	test('task.in needs a connection (min_connections, warning)', () => {
		const document = { ...validWorkflow(), nodes: [...validWorkflow().nodes, node('t9', 'task', { title: 'Floating' })] };
		const issues = validateDocument(example, document);

		expect(find(issues, 'min_connections')).toEqual([
			expect.objectContaining({ severity: 'warning', nodeId: 't9', port: 'in', message: '"Floating": input "In" needs at least 1 connection (has 0).' }),
		]);

		expect(find(issues, 'unreachable').map((issue) => issue.nodeId)).toEqual(['t9']);
	});

	test('event outputs cannot feed flow inputs (type_mismatch), but can feed notify.trigger', () => {
		const document = withEdges([edge('bad', 'a.escalate', 'ok.in', 'flow')]);
		const issues = find(validateDocument(example, document), 'type_mismatch');

		expect(issues).toEqual([
			expect.objectContaining({
				edgeId: 'bad',
				message: '"Approval by Security" → "End: Approved": output "Escalate" (Event) cannot connect to input "In" (Control flow).',
			}),
		]);
	});

	test('approval outputs allow one connection each and only Flow edges', () => {
		const document = withEdges([edge('x1', 'a.approved', 'n.in', 'flow'), edge('x2', 'a.rejected', 'ok.in', 'timeout')]);
		const issues = validateDocument(example, document);

		expect(find(issues, 'max_connections').map((issue) => issue.port)).toEqual(['approved', 'rejected']);
		expect(find(issues, 'edge_type_not_allowed')).toEqual([
			expect.objectContaining({ edgeId: 'x2', message: '"Approval by Security": output "Rejected" does not allow "Timeout" connections.' }),
		]);
	});

	test('task.next allows both Flow and Timeout', () => {
		expect(validateDocument(example, validWorkflow()).length).toBe(0);
		expect(validWorkflow().edges.find((item) => item.id === 'e2')!.type).toBe('timeout');
	});

	test('condition: one output per branch, at most one connection each; removed branches leave unknown ports', () => {
		const shrunk = withNode('c', { data: { label: 'Which system?', branches: [{ label: 'Production' }] } });
		const issues = validateDocument(example, shrunk);

		expect(find(issues, 'unknown_port')).toEqual([
			expect.objectContaining({ edgeId: 'e6', nodeId: 'c', port: 'branches.1', message: '"Which system?" has no output "branches.1" (connection to "End: Approved").' }),
		]);

		const doubled = withEdges([edge('x', 'c.branches.0', 'ok.in', 'flow')]);
		expect(find(validateDocument(example, doubled), 'max_connections').map((issue) => issue.port)).toEqual(['branches.0']);
	});

	test('end: an input connection is needed (min_connections) and the outcome shows in its title', () => {
		const document = { ...validWorkflow(), nodes: [...validWorkflow().nodes, node('e3', 'end', { outcome: 'cancelled' })] };
		const issues = validateDocument(example, document);
		expect(find(issues, 'min_connections')[0]!.message).toBe('"End: Cancelled": input "In" needs at least 1 connection (has 0).');
	});

	test('legacy_review is deprecated (deprecated_node_type, warning)', () => {
		const document = withEdges([]);
		document.nodes.push(node('old', 'legacy_review', { title: 'Old review' }));
		document.edges.push(edge('x', 'n.next', 'old.in', 'flow'));

		const issues = validateDocument(example, document);
		expect(find(issues, 'deprecated_node_type')).toEqual([
			expect.objectContaining({ severity: 'warning', nodeId: 'old', message: '"Old review" uses the deprecated node type "Legacy review".' }),
		]);
	});

	test('no self loops', () => {
		const issues = validateDocument(example, withEdges([edge('loop', 'n.next', 'n.in', 'flow')]));
		expect(find(issues, 'self_loop')).toEqual([expect.objectContaining({ edgeId: 'loop', message: '"Notify via Slack" is connected to itself.' })]);
	});

	test('cycles are allowed by the example', () => {
		const issues = validateDocument(example, withEdges([edge('back', 'n.next', 't.in', 'flow')]));
		expect(find(issues, 'cycle')).toEqual([]);
	});

	test('no multi-edges between the same ports', () => {
		const issues = validateDocument(example, withEdges([edge('again', 'n.next', 'ok.in', 'flow')]));
		expect(find(issues, 'multi_edge').map((issue) => issue.edgeId)).toEqual(['again']);
	});

	test('Start cannot go straight to End (deny pair with a custom message)', () => {
		const document = starterDocument(example);
		document.edges.push(edge('x', `${document.nodes[0]!.id}.next`, `${document.nodes[1]!.id}.in`, 'flow'));

		expect(find(validateDocument(example, document), 'pair_not_allowed')).toEqual([
			expect.objectContaining({ edgeId: 'x', message: '"Start" → "End": Start cannot go straight to End.' }),
		]);
	});

	test('unknown edge types', () => {
		const issues = validateDocument(example, withEdges([edge('x', 'n.next', 'no.in', 'warp')]));
		expect(find(issues, 'unknown_edge_type')).toEqual([
			expect.objectContaining({ edgeId: 'x', message: '"Notify via Slack" → "End: Rejected": the connection type "warp" is not defined.' }),
		]);
	});

	test('an edge without a type uses the default edge type', () => {
		const document = validWorkflow();
		delete document.edges[0]!.type;
		expect(validateDocument(example, document)).toEqual([]);
	});

	test('reachable from Start', () => {
		const document = validWorkflow();
		document.edges = document.edges.filter((item) => item.id !== 'e3');

		expect(find(validateDocument(example, document), 'unreachable').map((issue) => issue.nodeId)).toEqual(['c']);
	});

	test('maxNodes 200 and maxEdges 400', () => {
		const nodes = Array.from({ length: 201 }, (_, i) => node(`t${i}`, 'task', { title: `T${i}` }));
		const edges = Array.from({ length: 401 }, (_, i) => edge(`e${i}`, 't0.next', `t${i % 200}.in`, 'flow'));
		const issues = validateDocument(example, doc(nodes, edges));

		expect(find(issues, 'max_nodes')[0]!.message).toBe('The graph has 201 nodes; at most 200 are allowed.');
		expect(find(issues, 'max_edges')[0]!.message).toBe('The graph has 401 connections; at most 400 are allowed.');
	});

	test('errors come before warnings', () => {
		const issues = validateDocument(example, { ...starterDocument(example), nodes: [...starterDocument(example).nodes, node('t', 'task')] });
		const firstWarning = issues.findIndex((issue) => issue.severity === 'warning');
		expect(issues.slice(firstWarning).every((issue) => issue.severity === 'warning')).toBe(true);
		expect(issues[0]!.severity).toBe('error');
	});
});

describe('validateDocument: planted faults', () => {
	const report = validateValue(plantedRuleset, plantedJson);
	const issues = report.issues;

	test('every issue code is planted at least once (min_nodes contradicts max_nodes and is tested separately)', () => {
		const expected = ISSUE_CODES.filter((code) => code !== 'min_nodes');
		expect([...new Set(codes(issues))].sort()).toEqual([...expected].sort());
	});

	test('finds exactly the planted faults', () => {
		const summary = issues.map((issue) => [issue.code, issue.nodeId ?? issue.edgeId ?? '-', issue.port ?? ''].join(' '));

		expect(summary).toEqual([
			// errors, in discovery order
			'invalid_document - ',
			'duplicate_id dupe ',
			'field_required t2 ',
			'unknown_node_type ghost ',
			'dangling_edge e_dangling ',
			'unknown_edge_type e_unknown_type ',
			'unknown_port a1 nope',
			'type_mismatch e_type_mismatch ',
			'pair_not_allowed e_pair ',
			'self_loop t3 ',
			'multi_edge e_multi_2 ',
			'edge_type_not_allowed e_edge_type ',
			'wrong_direction e_reversed ',
			'unknown_port c1 branches.9',
			'max_connections t1 next',
			'max_connections a1 approved',
			'max_connections c1 branches.0',
			'max_instances s2 ',
			'max_nodes - ',
			'max_edges - ',
			'cycle e_cycle_1 ',
			'cycle e_cycle_2 ',
			// warnings
			'deprecated_node_type lr ',
			'min_connections s2 next',
			'min_connections dupe in',
			'min_connections c1 in',
			'min_instances - ',
			'not_connected s2 ',
			'not_connected ghost ',
			'not_connected lonely ',
			'not_connected dupe ',
			'unreachable ghost ',
			'unreachable lonely ',
			'unreachable dupe ',
			'unreachable c1 ',
			'unreachable n1 ',
		]);

		expect(find(issues, 'pair_not_allowed')[0]!.message).toBe('"Route" → "Notify via Email": The fallback branch cannot notify.');
	});

	test('the forbidden key is reported and dropped, the rest of the value is kept', () => {
		expect(report.problems).toEqual(['nodes[8].data.__proto__: the key is not allowed and was removed.']);
		expect(report.document!.nodes.find((item) => item.id === 'lonely')!.data).toEqual({ channel: 'email', message: 'TOP SECRET payload text' });
		expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
	});

	test('fingerprints are unique and independent of positions and message text', () => {
		const fingerprints = issues.map((issue) => issue.fingerprint);
		expect(new Set(fingerprints).size).toBe(fingerprints.length);

		const moved = JSON.parse(plantedJson);
		for (const item of moved.nodes) item.position = { x: item.position.x + 1000, y: 7 };
		moved.nodes.find((item: { id: string }) => item.id === 't1').data.title = 'Renamed';

		expect(validateValue(plantedRuleset, moved).issues.map((issue) => issue.fingerprint)).toEqual(fingerprints);
	});

	test('messages never contain node data other than titles', () => {
		for (const issue of issues) expect(issue.message).not.toContain('TOP SECRET');
	});

	test('min_nodes', () => {
		const ruleset = variant((copy) => {
			copy.graphRules = { ...copy.graphRules, minNodes: 3 };
		});

		const issues = validateDocument(ruleset, starterDocument(ruleset));
		expect(find(issues, 'min_nodes')).toEqual([expect.objectContaining({ severity: 'warning', message: 'The graph needs at least 3 nodes (it has 2).' })]);
	});
});

describe('validateDocument: severities and robustness', () => {
	test('severity overrides promote, demote and silence codes', () => {
		const ruleset = variant((copy) => {
			copy.severity = { unreachable: 'error', min_connections: 'off', field_required: 'warning' };
		});

		const document = starterDocument(ruleset);
		document.nodes.push(node('t', 'task'));
		const issues = validateDocument(ruleset, document);

		expect(find(issues, 'min_connections')).toEqual([]);
		expect(find(issues, 'unreachable').every((issue) => issue.severity === 'error')).toBe(true);
		expect(find(issues, 'field_required')[0]!.severity).toBe('warning');
	});

	test('cycles are reported per edge when forbidden, self loops are not cycles', () => {
		const ruleset = variant((copy) => {
			copy.connectionRules!.allowCycles = false;
			copy.connectionRules!.allowSelfLoops = true;
		});

		const document = withEdges([edge('back', 'n.next', 't.in', 'flow'), edge('self', 'no.in', 'no.in')]);
		document.edges.push(edge('selfloop', 't.next', 't.in', 'flow'));

		const cycleEdges = find(validateDocument(ruleset, document), 'cycle').map((issue) => issue.edgeId);
		// t → a → c → n → t and a → n (escalate) are all on the loop closed by `back`.
		expect(cycleEdges).toEqual(['e2', 'e3', 'e5', 'e9', 'back']);
	});

	test('does not throw on values that are not normalised documents', () => {
		const values: unknown[] = [null, 1, 'x', [], {}, { nodes: [null], edges: [] }, { nodes: [{ id: 1 }], edges: [] }, { nodes: [], edges: [{ id: 'e' }] }];

		for (const value of values) {
			const issues = validateDocument(example, value as GraphDocument);
			expect(codes(issues)).toEqual(['invalid_document']);
		}
	});

	test('validateValue: empty values have no document and no issues', () => {
		for (const raw of [null, undefined, '']) expect(validateValue(example, raw)).toEqual({ document: null, issues: [], problems: [] });
	});

	test('validateValue without a ruleset runs only the structural checks', () => {
		expect(validateValue(null, validWorkflow()).issues).toEqual([]);
		expect(codes(validateValue(null, '{ broken').issues)).toEqual(['invalid_document']);
	});

	test('issueFingerprint is unambiguous', () => {
		const a = issueFingerprint({ code: 'cycle', nodeId: 'a|b' });
		const b = issueFingerprint({ code: 'cycle', nodeId: 'a', edgeId: 'b' });
		expect(a).not.toBe(b);
	});

	test('scales linearly: hundreds of nodes validate quickly, long chains do not overflow', () => {
		const ruleset = variant((copy) => {
			copy.connectionRules!.allowCycles = false;
			copy.graphRules = { ...copy.graphRules, maxNodes: 100_000, maxEdges: 100_000 };
		});

		const build = (count: number) => {
			const nodes = [node('s', 'start', { title: 'Go' }), ...Array.from({ length: count }, (_, i) => node(`t${i}`, 'task', { title: `Step ${i}` }))];
			const edges = [edge('e-s', 's.next', 't0.in', 'flow'), ...Array.from({ length: count - 1 }, (_, i) => edge(`e${i}`, `t${i}.next`, `t${i + 1}.in`, 'flow'))];
			return doc(nodes, edges);
		};

		const medium = build(500);
		const started = performance.now();
		for (let i = 0; i < 10; i++) validateDocument(ruleset, { ...medium });
		const perRun = (performance.now() - started) / 10;

		expect(perRun).toBeLessThan(100);

		const long = build(20_000);
		const issues = validateDocument(ruleset, long);
		expect(codes(issues)).toEqual(['min_instances']);
	});
});

/** Narrow helper used in a type position only. */
export type _IssueCodes = IssueCode | Issue['code'];
