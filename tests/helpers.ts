/**
 * Builders shared by the test suites: the compiled example ruleset and a
 * terse way to write documents (`node('t1', 'task', { title: 'A' })`,
 * `edge('e1', 't1.next', 't2.in')`).
 */

import { compileRuleset, exampleRuleset } from '../src/shared/core';
import type { CompiledRuleset, GraphDocument, GraphEdge, GraphNode, Issue, IssueCode, Ruleset } from '../src/shared/core';

export function compileOrThrow(raw: unknown): CompiledRuleset {
	const { ruleset, problems } = compileRuleset(raw);
	if (!ruleset) throw new Error(`Ruleset did not compile:\n${problems.join('\n')}`);
	return ruleset;
}

export const example: CompiledRuleset = compileOrThrow(exampleRuleset);

/** A deep copy of the example ruleset with a change applied, compiled. */
export function variant(change: (ruleset: Ruleset) => void): CompiledRuleset {
	const copy = JSON.parse(JSON.stringify(exampleRuleset)) as Ruleset;
	change(copy);
	return compileOrThrow(copy);
}

/** A position derived from the id, so building the same document twice gives equal documents. */
function positionFor(id: string): { x: number; y: number } {
	let sum = 0;
	for (const char of id) sum = (sum * 31 + char.charCodeAt(0)) % 997;
	return { x: sum * 18, y: (sum % 7) * 90 };
}

export function node(id: string, type: string, data: Record<string, unknown> = {}): GraphNode {
	return { id, type, position: positionFor(id), data };
}

/** `edge('e1', 'a.next', 'b.in')`, optionally with a type and data. */
export function edge(id: string, from: string, to: string, type?: string, data?: Record<string, unknown>): GraphEdge {
	const [source, ...sourceHandle] = from.split('.');
	const [target, ...targetHandle] = to.split('.');

	// Same key order as normalizeDocument produces, so JSON comparisons are meaningful.
	const endpoints = { source: source!, sourceHandle: sourceHandle.join('.'), target: target!, targetHandle: targetHandle.join('.') };
	const result: GraphEdge = type !== undefined ? { id, type, ...endpoints } : { id, ...endpoints };

	if (data !== undefined) result.data = data;
	return result;
}

export function doc(nodes: GraphNode[], edges: GraphEdge[] = []): GraphDocument {
	return { format: 'directus-node-graph', version: 1, nodes, edges };
}

/**
 * A complete, valid approval workflow: start → task → approval; approved →
 * condition with two branches → notify / end; rejected → end; escalate →
 * notify.trigger.
 */
export function validWorkflow(): GraphDocument {
	return doc(
		[
			node('s', 'start', { title: 'Request received' }),
			node('t', 'task', { title: 'Prepare access', assignee: 'it', due_days: 2 }),
			node('a', 'approval', { approver: 'security', sla_hours: 24 }),
			node('c', 'condition', { label: 'Which system?', branches: [{ label: 'Production' }, { label: 'Staging' }] }),
			node('n', 'notify', { channel: 'slack', message: 'Access granted' }),
			node('ok', 'end', { outcome: 'approved' }),
			node('no', 'end', { outcome: 'rejected' }),
		],
		[
			edge('e1', 's.next', 't.in', 'flow'),
			edge('e2', 't.next', 'a.in', 'timeout', { after_hours: 48 }),
			edge('e3', 'a.approved', 'c.in', 'flow'),
			edge('e4', 'a.rejected', 'no.in', 'flow'),
			edge('e5', 'c.branches.0', 'n.in', 'flow', { label: 'prod' }),
			edge('e6', 'c.branches.1', 'ok.in', 'flow'),
			edge('e7', 'c.else', 'no.in', 'flow'),
			edge('e8', 'n.next', 'ok.in', 'flow'),
			edge('e9', 'a.escalate', 'n.trigger', 'flow'),
		],
	);
}

export function codes(issues: Issue[]): IssueCode[] {
	return issues.map((issue) => issue.code);
}

export function find(issues: Issue[], code: IssueCode): Issue[] {
	return issues.filter((issue) => issue.code === code);
}
