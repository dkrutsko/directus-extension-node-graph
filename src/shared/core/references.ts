/**
 * Item references in node and edge data: values that point at an item of
 * another collection, as the stock "Collection Item Dropdown" interfaces
 * store them. Titles, labels and card summaries show them as the referenced
 * item's display text when a ReferenceResolver knows it (the editor), and as
 * the item's key otherwise (the hook, the display, the editor before its
 * fetch returns), so a reference never renders as nothing.
 *
 * Pure and synchronous like the rest of core: recognising and collecting
 * references needs no schema and no network.
 */

import type { CompiledRuleset, GraphDocument, ItemReference, NodeGraphField, ReferenceResolver } from './types';
import { isPlainObject, safeKeys } from './util';

/**
 * The stock interfaces that store `{ key, collection }`
 * (directus-11.17.4/app/src/interfaces/collection-item-dropdown/collection-item-dropdown.vue:17-20)
 * or a list of them
 * (app/src/interfaces/collection-item-multiple-dropdown/collection-item-multiple-dropdown.vue:22-25).
 * Both take the options `selectedCollection`, `template` and `filter`.
 */
export const REFERENCE_INTERFACES: ReadonlySet<string> = new Set(['collection-item-dropdown', 'collection-item-multiple-dropdown']);

/** References inside data deeper than this are not collected (real data is a few levels deep). */
const MAX_REFERENCE_DEPTH = 8;

/** A field edited with one of the REFERENCE_INTERFACES. */
export function isReferenceField(field: NodeGraphField | null | undefined): field is NodeGraphField {
	const name = field?.meta?.interface;
	return typeof name === 'string' && REFERENCE_INTERFACES.has(name);
}

function isKey(value: unknown): value is string | number {
	return (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The reference a value holds, or null.
 *
 * - By shape, for any field: a plain object with exactly a `key` (non-empty
 *   text or a finite number) and a `collection` (non-empty text), so custom
 *   pickers that store the same shape are recognised too. Requiring exactly
 *   these two keys keeps ordinary objects (a repeater row with a `key`
 *   column, say) from being mistaken for references.
 * - By field, for the REFERENCE_INTERFACES: the object may carry other keys,
 *   and a missing `collection` is taken from the field's `selectedCollection`
 *   option, which is the collection the stock interface reads the item from
 *   (collection-item-dropdown.vue:88-97).
 *
 * A bare key is never a reference: `{{ customer.key }}` reads the key itself
 * through the same field and must stay plain text.
 */
export function asReference(value: unknown, field?: NodeGraphField | null): ItemReference | null {
	if (!isPlainObject(value)) return null;

	const key = value['key'];
	if (!isKey(key)) return null;

	const stored = value['collection'];

	if (isReferenceField(field)) {
		const selected = field.meta?.options?.['selectedCollection'];
		const collection = typeof stored === 'string' && stored !== '' ? stored : selected;
		return typeof collection === 'string' && collection !== '' ? { collection, key } : null;
	}

	if (typeof stored !== 'string' || stored === '') return null;

	const keys = safeKeys(value);
	return keys.length === 2 && keys.includes('key') && keys.includes('collection') ? { collection: stored, key } : null;
}

/** What a reference reads as: the resolver's text if it has one, else the key. */
export function referenceText(reference: ItemReference, field?: NodeGraphField, references?: ReferenceResolver | null): string {
	let label: string | undefined;

	try {
		label = references?.(reference, field);
	} catch {
		// A resolver is app code; a bug there must not break titles or validation.
		label = undefined;
	}

	return typeof label === 'string' && label !== '' ? label : String(reference.key);
}

/** One reference found in data, with the declared field it is the value (or a list item) of, if any. */
export interface ReferenceOccurrence {
	reference: ItemReference;
	field?: NodeGraphField;
}

/**
 * Every reference in one element's data. A declared field's value is read
 * with the field (so its interface counts, and a list of references is
 * attributed to it); references nested deeper inside other values, which
 * templates can reach with a path such as `{{ meta.customer }}`, are found
 * by shape and carry no field, exactly as formatValue sees them.
 */
export function collectReferences(data: unknown, fields?: readonly NodeGraphField[] | null): ReferenceOccurrence[] {
	const found: ReferenceOccurrence[] = [];
	if (!isPlainObject(data)) return found;

	const visit = (value: unknown, field: NodeGraphField | undefined, depth: number) => {
		if (depth > MAX_REFERENCE_DEPTH || value === null || typeof value !== 'object') return;

		const reference = asReference(value, field);

		if (reference) {
			found.push(field ? { reference, field } : { reference });
			return;
		}

		if (Array.isArray(value)) {
			// List items share the field, as formatValue formats them (a multiple dropdown's list).
			for (const item of value) visit(item, field, depth + 1);
			return;
		}

		if (isPlainObject(value)) {
			for (const key of safeKeys(value)) visit(value[key], undefined, depth + 1);
		}
	};

	for (const key of safeKeys(data)) {
		visit(data[key], fields?.find((candidate) => candidate?.field === key), 0);
	}

	return found;
}

/**
 * Every reference in a document's node and edge data, in document order,
 * not deduplicated. The editor's resolver collects per element instead, to
 * reuse the result for elements that did not change.
 */
export function documentReferences(ruleset: CompiledRuleset | null, document: GraphDocument | null): ReferenceOccurrence[] {
	if (!document) return [];

	const found: ReferenceOccurrence[] = [];

	for (const node of document.nodes ?? []) {
		found.push(...collectReferences(node?.data, ruleset?.nodeTypeMap.get(node?.type)?.fields));
	}

	for (const edge of document.edges ?? []) {
		const type = ruleset?.edgeTypeMap.get(edge?.type ?? ruleset.defaultEdgeType);
		found.push(...collectReferences(edge?.data, type?.fields));
	}

	return found;
}
