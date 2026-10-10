/**
 * The derived `meta` block of a document. Recomputed by the editor on Apply
 * and by the hook on every write; a stored `meta` is never trusted.
 */

import { graphHash } from './hash';
import type { CompiledRuleset, GraphDocument, GraphMeta, Issue } from './types';
import { FORBIDDEN_KEYS, setOwn } from './util';

/**
 * Counts, issue totals and the position-free graph hash. `ruleset` is
 * accepted for symmetry with the other helpers (and for future per-type
 * facts); the numbers depend only on the document and the issues passed in.
 * Count keys are sorted so the stored JSON is stable.
 */
export function computeMeta(_ruleset: CompiledRuleset | null, document: GraphDocument, issues: readonly Issue[]): GraphMeta {
	return { ...countMeta(document, issues), graphHash: graphHash(document) };
}

/**
 * computeMeta without the hash. The field row and the list display only show
 * counts, and hashing is the expensive part (a SHA-256 over the whole
 * document, several milliseconds for a few hundred nodes, per table row).
 */
export function countMeta(document: GraphDocument, issues: readonly Issue[]): Omit<GraphMeta, 'graphHash'> {
	const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
	const edges = Array.isArray(document?.edges) ? document.edges : [];

	const tally = new Map<string, number>();

	for (const node of nodes) {
		const type = typeof node?.type === 'string' ? node.type : '';
		// A forbidden type name must never become an object key.
		if (FORBIDDEN_KEYS.has(type)) continue;
		tally.set(type, (tally.get(type) ?? 0) + 1);
	}

	const counts: Record<string, number> = {};

	for (const key of [...tally.keys()].sort()) {
		setOwn(counts, key, tally.get(key)!);
	}

	let errorCount = 0;
	let warningCount = 0;

	for (const issue of issues) {
		if (issue.severity === 'error') errorCount++;
		else if (issue.severity === 'warning') warningCount++;
	}

	return { nodeCount: nodes.length, edgeCount: edges.length, errorCount, warningCount, counts };
}
