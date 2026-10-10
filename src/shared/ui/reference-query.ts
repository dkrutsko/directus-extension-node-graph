/**
 * What the editor asks the API for to show item references by name: which
 * template a reference is shown with, which endpoint and fields to request,
 * and how a fetched item becomes its label.
 *
 * Kept free of Vue and of the app's stores, which references.ts reads
 * through the small ReferenceSchema below, so the rules here run (and are
 * tested) in Node.
 */

import { collapseWhitespace } from '../core/util';
import { isReferenceField, renderTemplate, templatePaths, type ItemReference, type NodeGraphField } from '../core';

/** The facts about the schema and the current user's permissions that the planning needs. */
export interface ReferenceSchema {
	/** The collection is known to the app (for a non-admin, the collections store holds only the ones they may see). */
	hasCollection(collection: string): boolean;
	primaryKey(collection: string): string | null;
	displayTemplate(collection: string): string | null;
	hasField(collection: string, field: string): boolean;
	/** The collection an m2o or o2m field leads to, or null for other fields. */
	relatedCollection(collection: string, field: string): string | null;
	/** Whether the user may read the collection (no field) or one of its fields. Admins may read everything. */
	canRead(collection: string, field?: string): boolean;
}

/** Keys per request; keeps the query string well under the server's URL limit for large graphs. */
export const KEYS_PER_REQUEST = 100;

/**
 * The REST endpoint of a collection, as the stock interfaces pick it with
 * getEndpoint() (directus-11.17.4/packages/utils/shared/get-endpoint.ts:3-9):
 * system collections have their own routes (directus_users → /users,
 * directus_files → /files). Only system collections can start with
 * `directus_`; the API refuses that prefix for user collections
 * (api/src/services/collections.ts:74-75).
 */
export function referenceEndpoint(collection: string): string {
	return collection.startsWith('directus_') ? `/${collection.slice('directus_'.length)}` : `/items/${encodeURIComponent(collection)}`;
}

/**
 * The template a reference is shown with, in the stock interface's order
 * (collection-item-dropdown.vue:61-67): the field's own `template` option,
 * the collection's display template, then the primary key. The field's
 * option only counts for the stock reference interfaces, where it is known
 * to mean exactly this (a Repeater's `template` is its row template), and
 * only for the collection the field picks from. '' when nothing is known.
 */
export function referenceTemplate(schema: ReferenceSchema, collection: string, field?: NodeGraphField): string {
	if (isReferenceField(field)) {
		const options = field.meta?.options ?? {};
		const own = options['template'];
		const selected = options['selectedCollection'];

		if (typeof own === 'string' && own.trim() !== '' && (typeof selected !== 'string' || selected === collection)) return own;
	}

	const display = schema.displayTemplate(collection);
	if (typeof display === 'string' && display.trim() !== '') return display;

	const primaryKey = schema.primaryKey(collection);
	return primaryKey ? `{{${primaryKey}}}` : '';
}

/** Cache key of one label: the same item can be shown with different templates. */
export function labelKey(collection: string, template: string, key: ItemReference['key']): string {
	return `${collection}\u0000${template}\u0000${String(key)}`;
}

/**
 * The field to request for one template path, or null. The path is followed
 * through m2o and o2m relations as long as each field exists and is readable,
 * and cut where it stops: a path into a JSON field requests the whole field
 * (the renderer reads the rest from its value), and a relation the user may
 * not follow requests just the foreign key. Requesting a field that does not
 * exist or is not readable makes the API refuse the whole request with 403,
 * so nothing unknown is ever asked for.
 */
function plannedPath(schema: ReferenceSchema, collection: string, path: string): string | null {
	const segments = path.split('.');
	const kept: string[] = [];
	let current = collection;

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!;
		if (!schema.hasField(current, segment) || !schema.canRead(current, segment)) break;

		kept.push(segment);
		if (index === segments.length - 1) break;

		const related = schema.relatedCollection(current, segment);
		if (!related || !schema.canRead(related)) break;
		current = related;
	}

	return kept.length > 0 ? kept.join('.') : null;
}

export type ReferencePlan =
	| { kind: 'fetch'; endpoint: string; primaryKey: string; fields: string[] }
	/** Nothing to ask for: every template shows only the key, so the key fallback is the label. */
	| { kind: 'keys' }
	/** The collection is unknown or not readable for this user: show keys without asking (a request would only 403). */
	| { kind: 'unreadable' };

/** How to load the items of one collection for the given templates, in one request. */
export function planReferenceRequest(schema: ReferenceSchema, collection: string, templates: Iterable<string>): ReferencePlan {
	if (!schema.hasCollection(collection) || !schema.canRead(collection)) return { kind: 'unreadable' };

	const primaryKey = schema.primaryKey(collection);
	if (!primaryKey || !schema.canRead(collection, primaryKey)) return { kind: 'unreadable' };

	const fields = new Set<string>([primaryKey]);

	for (const template of templates) {
		for (const path of templatePaths(template)) {
			const planned = plannedPath(schema, collection, path);
			if (planned) fields.add(planned);
		}
	}

	if (fields.size === 1) return { kind: 'keys' };

	return { kind: 'fetch', endpoint: referenceEndpoint(collection), primaryKey, fields: [...fields] };
}

/**
 * Query parameters of one request. The filter and the field list go as
 * strings (JSON and comma-separated), which the API parses the same as the
 * bracket notation, so the request does not depend on how the app's HTTP
 * client serialises nested parameters.
 */
export function referenceQuery(plan: Extract<ReferencePlan, { kind: 'fetch' }>, keys: readonly ItemReference['key'][]): Record<string, string | number> {
	return {
		fields: plan.fields.join(','),
		filter: JSON.stringify({ [plan.primaryKey]: { _in: keys } }),
		limit: -1,
	};
}

/**
 * The label of a fetched item: the template rendered as plain text by the
 * core renderer (so a dotted path reads the nested related item, and no HTML
 * is ever produced), or undefined when it comes out empty, which shows the
 * key instead.
 */
export function referenceLabel(template: string, item: unknown): string | undefined {
	const text = collapseWhitespace(renderTemplate(template, item));
	return text === '' ? undefined : text;
}
