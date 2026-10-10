/**
 * The text of the field row (item form) and of the summary display.
 */

import { countMeta } from './meta';
import { renderTemplateDetailed } from './template';
import type { CompiledRuleset, GraphDocument, Issue, NodeGraphFieldOptions } from './types';
import { validateDocument } from './validate';
import { collapseWhitespace, setOwn } from './util';

/** What the field row and the display show when the options set no template (pluralised). */
export const DEFAULT_FIELD_TEMPLATE = '{{nodeCount}} nodes · {{edgeCount}} connections';

/**
 * The field row and display text. Uses `options.template` (tokens:
 * nodeCount, edgeCount, errorCount, warningCount, counts.<typeKey>,
 * ruleset.name, ruleset.version), or a pluralised default equivalent to
 * DEFAULT_FIELD_TEMPLATE. Pass `issues` when they are already known to avoid
 * validating twice. Returns '' for an empty field (callers show the
 * placeholder).
 */
export function fieldSummary(
	options: NodeGraphFieldOptions | null | undefined,
	ruleset: CompiledRuleset | null,
	document: GraphDocument | null,
	issues?: Issue[],
): string {
	if (!document) return '';

	const template = typeof options?.template === 'string' ? options.template.trim() : '';

	// The display renders this once per table row, so do only the work the
	// text needs: the default text has no issue counts (no validation), and no
	// text shows the graph hash (countMeta, not computeMeta).
	if (template === '') {
		const meta = countMeta(document, []);
		const nodes = `${meta.nodeCount} ${meta.nodeCount === 1 ? 'node' : 'nodes'}`;
		const edges = `${meta.edgeCount} ${meta.edgeCount === 1 ? 'connection' : 'connections'}`;
		return `${nodes} · ${edges}`;
	}

	const resolvedIssues = issues ?? (ruleset ? validateDocument(ruleset, document) : []);
	const meta = countMeta(document, resolvedIssues);

	// Every type of the ruleset counts, so `{{counts.approval}}` shows 0 rather than nothing.
	const counts: Record<string, number> = {};
	for (const type of ruleset?.nodeTypes ?? []) setOwn(counts, type.key, 0);
	for (const [key, count] of Object.entries(meta.counts)) setOwn(counts, key, count);

	const scope = {
		nodeCount: meta.nodeCount,
		edgeCount: meta.edgeCount,
		errorCount: meta.errorCount,
		warningCount: meta.warningCount,
		counts,
		ruleset: ruleset ? { key: ruleset.key, name: ruleset.name, version: ruleset.version } : {},
	};

	return collapseWhitespace(renderTemplateDetailed(template, scope).text);
}
