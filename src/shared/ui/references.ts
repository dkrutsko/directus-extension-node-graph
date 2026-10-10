/**
 * Display text for item references in the open editor.
 *
 * Node and edge fields can point at items of other collections with the
 * stock "Collection Item Dropdown" interfaces (core/references.ts). Core
 * renders such a value as its key; this composable gives the editor a
 * ReferenceResolver that knows the referenced items' display text, so cards,
 * connection labels, the inspector and the issues read "ssh-adserver" where
 * the stock picker shows it, instead of "3".
 *
 * - It collects every reference in the open document (per element, reusing
 *   the result for elements whose data did not change, so dragging costs a
 *   map lookup per node), and loads what is missing with one request per
 *   collection: the primary key `_in` the keys, only the fields the
 *   templates need (relational paths included), `limit=-1`
 *   (reference-query.ts).
 * - Labels are cached per collection, template and key. Opening the editor
 *   again revalidates them while still showing the cached text; new
 *   references are loaded after a short debounce. Requests only go out for
 *   entries that are neither cached for this opening nor in flight, so
 *   nothing can loop.
 * - A collection the user cannot read is never requested (the permissions
 *   store says so up front, and a 403 would show up as a console error). A
 *   request that fails anyway is logged once and the collection is not asked
 *   again in this browser session; its references show their keys. Items
 *   that do not exist (deleted) show their keys too. Nothing here throws.
 * - Labels are reactive: the resolver reads a version counter, so every
 *   computed that called it re-runs when labels arrive.
 *
 * It only fetches while the editor is open. The field row and the display
 * show no element text, and the hook never has a resolver: there references
 * read as their keys.
 */

import { useApi, useStores } from '@directus/extensions-sdk';
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import {
	collectReferences,
	type CompiledRuleset,
	type GraphDocument,
	type NodeGraphField,
	type ReferenceOccurrence,
	type ReferenceResolver,
} from '../core';
import type { ReferenceLabels } from './canvas-contract';
import {
	KEYS_PER_REQUEST,
	labelKey,
	planReferenceRequest,
	referenceLabel,
	referenceQuery,
	referenceTemplate,
	type ReferenceSchema,
} from './reference-query';

/** How the shell hands the labels to the inspector and the issue lists. */
export const REFERENCE_LABELS: InjectionKey<ComputedRef<ReferenceLabels>> = Symbol('node-graph-reference-labels');

/** New references are loaded this long after the last change (typing in a repeater, several picks in a row). */
const DEBOUNCE_MS = 150;

/*
 * Collections that failed for a user in this browser session, shared by every
 * graph field on the page: after one failure (and one console warning) their
 * references show keys without asking again until the app is reloaded.
 */
const failedCollections = new Set<string>();

interface Wanted {
	collection: string;
	key: string | number;
	template: string;
}

interface Label {
	/** null: the item was not found, or its template came out empty; the key is shown. */
	text: string | null;
	/** The opening of the editor the label was loaded in; older ones are shown but reloaded. */
	generation: number;
}

interface Environment {
	api: { get(url: string, config: { params: Record<string, string | number> }): Promise<{ data?: { data?: unknown } }> };
	schema: ReferenceSchema & { reset(): void };
	userKey(): string;
}

export function useReferenceLabels(options: {
	document: Ref<GraphDocument>;
	ruleset: Ref<CompiledRuleset>;
	/** Fetch only while this is true (the editor drawer is open). */
	active: Ref<boolean>;
	/** Console prefix, `[node-graph]`. */
	logPrefix: string;
}): ComputedRef<ReferenceLabels> {
	const environment = connect();
	const version = ref(0);
	const labels = new Map<string, Label>();
	const inFlight = new Set<string>();
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let urgent = false;

	/** Occurrences per element data object: documents are immutable, so unchanged elements keep their data object. */
	const occurrences = new WeakMap<object, { fields: unknown; found: ReferenceOccurrence[] }>();

	function referencesOf(data: unknown, fields: readonly NodeGraphField[] | undefined): ReferenceOccurrence[] {
		if (typeof data !== 'object' || data === null) return [];

		const cached = occurrences.get(data);
		if (cached && cached.fields === fields) return cached.found;

		const found = collectReferences(data, fields);
		occurrences.set(data, { fields, found });
		return found;
	}

	function templateOf(collection: string, field?: NodeGraphField): string {
		if (!environment) return '';

		try {
			return referenceTemplate(environment.schema, collection, field);
		} catch {
			// A store that changed shape in a later Directus: show keys rather than break rendering.
			return '';
		}
	}

	/** Every reference of the open document, deduplicated by label key. */
	const wanted = computed(() => {
		const result = new Map<string, Wanted>();
		if (!environment || !options.active.value) return result;

		const ruleset = options.ruleset.value;
		const document = options.document.value;

		const add = (found: ReferenceOccurrence[]) => {
			for (const { reference, field } of found) {
				const template = templateOf(reference.collection, field);
				if (template === '') continue;

				const key = labelKey(reference.collection, template, reference.key);
				if (!result.has(key)) result.set(key, { collection: reference.collection, key: reference.key, template });
			}
		};

		for (const node of document.nodes) add(referencesOf(node.data, ruleset.nodeTypeMap.get(node.type)?.fields));

		for (const edge of document.edges) {
			add(referencesOf(edge.data, ruleset.edgeTypeMap.get(edge.type ?? ruleset.defaultEdgeType)?.fields));
		}

		return result;
	});

	/* A string, so moving nodes (a new document, the same references) does not wake the watcher below. */
	const wantedSignature = computed(() => [...wanted.value.keys()].join('\u0001'));

	watch(
		[wantedSignature, options.active],
		([, active], previous) => {
			if (!active) {
				cancelTimer();
				return;
			}

			if (!previous?.[1]) {
				/*
				 * Just opened: revalidate what is cached (still shown meanwhile).
				 * Load on the next task rather than now, because the editor loads
				 * the session's document in a watcher of its own that may run after
				 * this one.
				 */
				generation++;
				environment?.schema.reset();
				schedule(0);
				return;
			}

			schedule(DEBOUNCE_MS);
		},
		{ immediate: true },
	);

	onBeforeUnmount(cancelTimer);

	/** Debounced; a load due right away (on open) is never pushed back by a change that follows it. */
	function schedule(delay: number) {
		if (timer && urgent) return;

		cancelTimer();
		urgent = delay === 0;
		timer = setTimeout(() => {
			timer = null;
			urgent = false;
			void flush();
		}, delay);
	}

	function cancelTimer() {
		if (timer) clearTimeout(timer);
		timer = null;
		urgent = false;
	}

	function failedKey(collection: string): string {
		return `${environment?.userKey() ?? ''}\u0000${collection}`;
	}

	async function flush() {
		if (!environment || !options.active.value) return;

		const byCollection = new Map<string, Array<[string, Wanted]>>();

		for (const [key, entry] of wanted.value) {
			if (inFlight.has(key) || labels.get(key)?.generation === generation) continue;
			if (failedCollections.has(failedKey(entry.collection))) continue;

			const group = byCollection.get(entry.collection) ?? [];
			group.push([key, entry]);
			byCollection.set(entry.collection, group);
		}

		await Promise.all([...byCollection].map(([collection, entries]) => load(environment, collection, entries)));
	}

	async function load(env: Environment, collection: string, entries: Array<[string, Wanted]>) {
		const loadedIn = generation;
		const store = (key: string, text: string | null) => labels.set(key, { text, generation: loadedIn });

		let plan: ReturnType<typeof planReferenceRequest>;

		try {
			plan = planReferenceRequest(env.schema, collection, new Set(entries.map(([, entry]) => entry.template)));
		} catch (error) {
			fail(collection, entries, error);
			return;
		}

		if (plan.kind === 'unreadable') {
			// Expected for users without access: no request, no warning, keys for the rest of the session.
			failedCollections.add(failedKey(collection));
			return;
		}

		if (plan.kind === 'keys') {
			for (const [key] of entries) store(key, null);
			return;
		}

		for (const [key] of entries) inFlight.add(key);

		try {
			const keys = [...new Map(entries.map(([, entry]) => [String(entry.key), entry.key])).values()];
			const items = new Map<string, unknown>();

			for (let start = 0; start < keys.length; start += KEYS_PER_REQUEST) {
				const response = await env.api.get(plan.endpoint, { params: referenceQuery(plan, keys.slice(start, start + KEYS_PER_REQUEST)) });
				const data = response?.data?.data;

				for (const item of Array.isArray(data) ? data : []) {
					const id = (item as Record<string, unknown> | null)?.[plan.primaryKey];
					if (id !== null && id !== undefined) items.set(String(id), item);
				}
			}

			for (const [key, entry] of entries) {
				const item = items.get(String(entry.key));
				store(key, item === undefined ? null : (referenceLabel(entry.template, item) ?? null));
			}
		} catch (error) {
			fail(collection, entries, error);
		} finally {
			for (const [key] of entries) inFlight.delete(key);
			version.value++;
		}
	}

	function fail(collection: string, entries: Array<[string, Wanted]>, error: unknown) {
		const key = failedKey(collection);
		// Two loads of one collection can be in flight at once (references added while the first ran); warn once.
		const first = !failedCollections.has(key);
		failedCollections.add(key);

		for (const [entry] of entries) labels.delete(entry);
		// Labels from an earlier opening may have been on screen: show the keys now.
		version.value++;

		if (!first) return;

		const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
		const reason = typeof status === 'number' ? `HTTP ${status}` : error instanceof Error ? error.message : String(error);

		// eslint-disable-next-line no-console
		console.warn(`${options.logPrefix} could not load items of "${collection}" to show references by name (${reason}); showing their keys.`);
	}

	const resolve: ReferenceResolver = (reference, field) => {
		// Read first, so whoever calls this re-runs when labels arrive.
		void version.value;

		const template = templateOf(reference.collection, field);
		if (template === '') return undefined;

		return labels.get(labelKey(reference.collection, template, reference.key))?.text ?? undefined;
	};

	return computed(() => ({ resolve, version: version.value }));
}

/**
 * The app's HTTP client and stores, or null outside the app (the composable
 * then resolves nothing and references show their keys). useApi and
 * useStores read app-level provides (directus-11.17.4/app/src/composables/use-system.ts:22-44).
 */
function connect(): Environment | null {
	try {
		const api = useApi() as unknown as Environment['api'];
		const stores = useStores();
		const collections = stores['useCollectionsStore']();
		const fields = stores['useFieldsStore']();
		const relations = stores['useRelationsStore']();
		const permissions = stores['usePermissionsStore']();
		const user = stores['useUserStore']();

		return { api, schema: storeSchema(collections, fields, relations, permissions, user), userKey: () => String(user['currentUser']?.id ?? '') };
	} catch {
		return null;
	}
}

type Store = Record<string, any>;

/**
 * ReferenceSchema over the app's Pinia stores, memoised per opening of the
 * editor: the fields store answers by scanning every field of the project
 * (stores/fields.ts:329-335, 379-385), and labels are resolved for every
 * reference on every render.
 */
function storeSchema(collections: Store, fields: Store, relations: Store, permissions: Store, user: Store): ReferenceSchema & { reset(): void } {
	const memo = new Map<string, unknown>();

	const remember = <T>(key: string, compute: () => T): T => {
		if (memo.has(key)) return memo.get(key) as T;
		const value = compute();
		memo.set(key, value);
		return value;
	};

	const collection = (name: string) => remember(`c\u0000${name}`, () => collections['getCollection'](name) ?? null);

	return {
		reset: () => memo.clear(),

		hasCollection: (name) => collection(name) !== null,

		primaryKey: (name) => remember(`p\u0000${name}`, () => fields['getPrimaryKeyFieldForCollection'](name)?.field ?? null),

		displayTemplate: (name) => {
			const template = collection(name)?.meta?.display_template;
			return typeof template === 'string' ? template : null;
		},

		hasField: (name, field) => remember(`f\u0000${name}\u0000${field}`, () => fields['getField'](name, field) !== null),

		/*
		 * m2o: the relation row of this field; o2m: the row whose one_field it is
		 * (relations store getRelationsForField returns both directions,
		 * stores/relations.ts:58-89). m2a has no single related collection.
		 */
		relatedCollection: (name, field) =>
			remember(`r\u0000${name}\u0000${field}`, () => {
				const rows: Store[] = relations['getRelationsForField'](name, field) ?? [];

				for (const row of rows) {
					if (row['collection'] === name && row['field'] === field && typeof row['related_collection'] === 'string') return row['related_collection'];
					if (row['related_collection'] === name && row['meta']?.one_field === field && typeof row['collection'] === 'string') return row['collection'];
				}

				return null;
			}),

		/*
		 * The permissions store holds, per collection and action, the access
		 * level and a superset of the readable fields (stores/permissions.ts:65-74,
		 * types/permissions.ts); admins may read everything.
		 */
		canRead: (name, field) => {
			if (user['isAdmin'] === true) return true;

			const permission = permissions['getPermission'](name, 'read');
			if (!permission || permission.access === 'none') return false;
			if (field === undefined || !Array.isArray(permission.fields)) return true;

			return permission.fields.includes('*') || permission.fields.includes(field);
		},
	};
}
