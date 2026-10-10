/**
 * Text shown for elements: node titles, edge labels and node card
 * summaries. All plain text (see template.ts).
 */

import { formatValue, renderTemplateDetailed } from './template';
import type { CompiledRuleset, GraphEdge, GraphNode } from './types';
import { collapseWhitespace, formatTitle, isPlainObject, truncate } from './util';

const MAX_TITLE_LENGTH = 120;

/**
 * Renders an element template against its data plus `$type`. If the template
 * has tokens and every one of them came out empty ("End: {{outcome}}" before
 * an outcome is picked) the result is '' so callers can fall back, instead of
 * showing a dangling "End:".
 */
function renderElementTemplate(
	template: string | undefined,
	data: unknown,
	typeLabel: string,
	fields: Parameters<typeof renderTemplateDetailed>[2],
): string {
	if (!template) return '';

	const scope = { ...(isPlainObject(data) ? data : {}), $type: typeLabel };
	const result = renderTemplateDetailed(template, scope, fields);

	if (result.tokens > 0 && result.filled === 0) return '';
	return truncate(collapseWhitespace(result.text), MAX_TITLE_LENGTH);
}

/**
 * Title of a node: its type's `titleTemplate` rendered against its data,
 * falling back to the type label (or, for an unknown type, the raw type key).
 */
export function nodeTitle(ruleset: CompiledRuleset | null, node: GraphNode): string {
	const type = ruleset?.nodeTypeMap.get(node?.type);
	if (!type) return node?.type ? node.type : 'Unknown node';

	return renderElementTemplate(type.titleTemplate, node.data, type.label, type.fields) || type.label;
}

/** Label of an edge from its type's `labelTemplate`; '' means no label. */
export function edgeLabel(ruleset: CompiledRuleset | null, edge: GraphEdge): string {
	if (!ruleset) return '';

	const type = ruleset.edgeTypeMap.get(edge?.type ?? ruleset.defaultEdgeType);
	if (!type) return '';

	return renderElementTemplate(type.labelTemplate, edge.data, type.label, type.fields);
}

/**
 * The lines under a node card's title: one per `summaryFields` entry that has
 * a value, labelled with the field name and formatted like the form shows it
 * (choice text, Yes/No, lists joined). Empty values are left out.
 */
export function nodeSummary(ruleset: CompiledRuleset | null, node: GraphNode): Array<{ label: string; value: string }> {
	const type = ruleset?.nodeTypeMap.get(node?.type);
	if (!type || !type.summaryFields || !isPlainObject(node.data)) return [];

	const lines: Array<{ label: string; value: string }> = [];

	for (const key of type.summaryFields) {
		const field = type.fields?.find((candidate) => candidate.field === key);
		const value = collapseWhitespace(formatValue(node.data[key], field));
		if (value === '') continue;

		lines.push({ label: field?.name || formatTitle(key), value: truncate(value, MAX_TITLE_LENGTH) });
	}

	return lines;
}
