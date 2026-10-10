/**
 * Document helpers for the editor shell: comparing documents and preparing
 * the value that Apply hands to the form.
 */

import {
	canonicalJson,
	computeMeta,
	normalizeDocument,
	validateDocument,
	type CompiledRuleset,
	type GraphDocument,
	type Issue,
} from '../core';

/**
 * What a user would call "the graph": nodes (with positions) and edges.
 * The viewport, the ruleset stamp and the derived `meta` are left out, so
 * panning or a recomputed `meta` never count as a change. Key order does not
 * matter (canonicalJson sorts keys), which also makes the signature of a
 * value survive the deep clone the form makes of it
 * (directus-11.17.4/app/src/components/v-form/utils/selective-clone.ts).
 */
export function documentSignature(document: GraphDocument | null | undefined): string {
	if (!document) return canonicalJson({ nodes: [], edges: [] });
	return canonicalJson({ nodes: document.nodes, edges: document.edges });
}

/** Signature of a raw field value (null, string or object), normalised first. */
export function valueSignature(value: unknown): string {
	return documentSignature(normalizeDocument(value).document);
}

/**
 * True when `current` differs from `baseline` in nodes or edges. Undo
 * restores the exact snapshot objects (history.ts), so identity settles the
 * common cases without serialising anything.
 */
export function hasGraphChanges(current: GraphDocument, baseline: GraphDocument): boolean {
	if (current.nodes === baseline.nodes && current.edges === baseline.edges) return false;
	return documentSignature(current) !== documentSignature(baseline);
}

/**
 * Whether Apply should treat the viewport of `current` as unchanged from
 * `baseline`.
 *
 * A baseline without a viewport matches any viewport. A graph stored without
 * one is fitted when the editor opens, and the canvas reports that fit with
 * `setViewport` so the zoom readout is right (canvas-contract.ts). That fit
 * is not an edit: if it counted, Apply without any change would emit a value
 * and turn the item form dirty ("unsaved changes" on leaving). The cost is
 * that panning alone on such a graph is not saved, which matches how Flows
 * treats its canvas. After the first Apply that does emit (any edit), the
 * value carries a viewport and later pans are saved.
 */
export function sameViewport(current: GraphDocument, baseline: GraphDocument): boolean {
	const left = current.viewport;
	const right = baseline.viewport;
	if (!right) return true;
	if (!left) return false;
	return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

/**
 * The value Apply emits: normalised (so nothing the editor could not
 * represent slips through), with a fresh `meta` and the ruleset stamp. The
 * hook recomputes both on save anyway; the editor writes them so the staged
 * value already looks like a saved one.
 */
export function prepareForApply(ruleset: CompiledRuleset, document: GraphDocument): { document: GraphDocument; issues: Issue[] } {
	const normalized = normalizeDocument(document).document;
	const issues = validateDocument(ruleset, normalized);

	normalized.ruleset = { key: ruleset.key, version: ruleset.version };
	normalized.meta = computeMeta(ruleset, normalized, issues);

	return { document: normalized, issues };
}
