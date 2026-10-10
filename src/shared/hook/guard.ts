/**
 * Server-side enforcement for node-graph fields.
 *
 * `createGuard(interfaceId)` returns the callback src/hook.ts passes to
 * `defineHook()`. It validates every graph written through ItemsService (the
 * app, REST, GraphQL, WebSockets, imports, MCP/AI tools, revision reverts,
 * version promotion, flows with "Emit Events" on) with the same core the
 * editor uses, applies the field's enforcement policy, and writes back a
 * recomputed `meta` and ruleset stamp. It also refuses to save a field whose
 * ruleset does not compile.
 *
 * Directus internals this relies on (11.17.4):
 *
 * - Filter signature `(payload, meta, context)`; `items.create` meta is
 *   `{ event, collection }`, `items.update` meta is `{ event, keys,
 *   collection }` (api/src/services/items.ts:155-168 and 731-746; the event
 *   name is added by api/src/emitter.ts:50). Only user collections emit
 *   `items.*`; system collections use their own scope (`users.update`, ...).
 * - On create the filter runs inside the write transaction and
 *   `context.database` is that transaction (items.ts:151-168). knex's SQLite
 *   dialect uses a one-connection pool, so querying through the root
 *   connection from here would wait on the transaction forever. Every query
 *   below therefore goes through the event's `context.database`, never the
 *   `database` captured at registration.
 * - Filters run before permission checks (items.ts:726-760), so error
 *   messages name only ids, node titles, port labels and issue codes.
 * - `SchemaOverview` has no `interface` or `options`
 *   (packages/types/src/schema.ts:5-19), hence the field map read from
 *   directus_fields, cached for 60 s and cleared on `fields.*` actions (which
 *   fire only on the instance that handled the change; the TTL covers the
 *   others).
 * - Rejections are `FAILED_VALIDATION` errors: the app keeps those with
 *   `VALIDATION_TYPES` codes (app/src/constants.ts:3,
 *   app/src/composables/use-item/index.ts:428-446) and shows them under the
 *   field when `extensions.collection` and `extensions.field` match
 *   (app/src/components/v-form/v-form.vue:527-533). Under the field the text
 *   comes from `validationError.<type>` or the field's own
 *   `validation_message` (form-field.vue:91-117); there is no translation for
 *   a custom type, so `type` is 'regex' ("Value doesn't have the correct
 *   format"). The form's error notice prefers `extensions.validation_message`
 *   (app/src/composables/use-validation-error-details.ts:66-73), which carries
 *   the actual issues. Errors are detected by `name === 'DirectusError'`
 *   (packages/errors/src/is-directus-error.ts:14-19), so the bundled copy of
 *   @directus/errors is recognised by the host.
 * - Field saves emit `fields.create` / `fields.update` filters with the field
 *   payload (api/src/services/fields.ts:403-417 and 518-532). `schema apply`
 *   runs FieldsService without accountability, and a snapshot must always
 *   apply, so the ruleset check is skipped there.
 */

import { InvalidPayloadError, createError } from '@directus/errors';
import type { EventContext, HookConfig, PrimaryKey } from '@directus/types';
import type { Knex } from 'knex';
import { compileRuleset, computeMeta, normalizeDocument, validateValue } from '../core';
import type { CompiledRuleset, GraphDocument, Issue, IssueCode } from '../core';
import { isPlainObject, setOwn } from '../core/util';
import { resolveFieldOptions, type ResolvedFieldOptions } from '../options';

/** How long the directus_fields lookup is trusted without a `fields.*` action. */
export const FIELD_MAP_TTL = 60_000;

/** Issues listed in a rejection message; the rest are counted. */
const MAX_LISTED_ISSUES = 5;

/** Rows per `whereIn` when reading stored values (SQLite's default variable limit is 999). */
const KEY_CHUNK_SIZE = 500;

export interface GraphField {
	field: string;
	options: ResolvedFieldOptions;
	/** null when the field has no ruleset or it does not compile; only structural checks run then. */
	ruleset: CompiledRuleset | null;
	problems: string[];
}

export type FieldMap = Map<string, GraphField[]>;

/** `extensions` of a rejection. Shaped like FailedValidationError's, plus what the app and API clients need. */
export interface GraphValidationExtensions {
	collection: string;
	field: string;
	path: string[];
	type: 'regex';
	/** Shown by the app's validation notice instead of the generic text. */
	validation_message: string;
	/** Ids and codes only, for clients that want to point at the elements. */
	issues: Array<{ code: IssueCode; nodeId?: string; edgeId?: string; port?: string; field?: string }>;
}

export const GraphValidationError = createError<GraphValidationExtensions>(
	'FAILED_VALIDATION',
	(extensions) => `Validation failed for field "${extensions.field}". ${extensions.validation_message}`,
	400,
);

interface Logger {
	debug: (...args: any[]) => void;
	info: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	error: (...args: any[]) => void;
}

/**
 * The hook for one interface id. Registers:
 *
 * - filters `items.create` / `items.update`: validate and enforce;
 * - filters `fields.create` / `fields.update`: reject fields whose ruleset
 *   does not compile (only with an accountability);
 * - actions `fields.create|update|delete`: clear the field map.
 */
export function createGuard(interfaceId: string): HookConfig {
	return ({ filter, action }, { logger }) => {
		const fieldMap = createFieldMapCache(interfaceId, logger);

		for (const event of ['fields.create', 'fields.update', 'fields.delete']) {
			action(event, () => fieldMap.clear());
		}

		filter('items.create', (payload, meta, context) => guardItem(payload, meta, context, 'create'));
		filter('items.update', (payload, meta, context) => guardItem(payload, meta, context, 'update'));

		filter('fields.create', (payload, meta, context) => guardField(payload, meta, context, false));
		filter('fields.update', (payload, meta, context) => guardField(payload, meta, context, true));

		async function guardItem(
			payload: unknown,
			meta: Record<string, any>,
			context: EventContext,
			event: 'create' | 'update',
		): Promise<unknown> {
			if (!isPlainObject(payload)) return payload;

			const collection = meta['collection'];
			if (typeof collection !== 'string') return payload;

			let fields: GraphField[] | undefined;

			try {
				fields = (await fieldMap.get(context.database)).get(collection);
			} catch (error) {
				// Unmanaged writes must never fail because of this hook.
				logger.error(error, `node-graph (${interfaceId}): could not read the field map; not enforcing`);
				return payload;
			}

			const present = (fields ?? []).filter(
				(graphField) => Object.prototype.hasOwnProperty.call(payload, graphField.field) && graphField.options.enforcement !== 'off',
			);

			if (present.length === 0) return payload;

			const keys: PrimaryKey[] = event === 'update' && Array.isArray(meta['keys']) ? meta['keys'] : [];
			const needsStored = keys.length > 0 && present.some((graphField) => graphField.options.enforcement === 'ratchet');
			let stored: Map<string, Record<string, unknown>> | null = null;

			if (needsStored) {
				try {
					stored = await readStored(context, collection, present, keys);
				} catch (error) {
					// Without the stored values there is nothing to ratchet against: behave like `reject`.
					logger.error(error, `node-graph (${interfaceId}): could not read stored graphs of ${collection}; treating them as empty`);
					stored = new Map();
				}
			}

			const rejections: InstanceType<typeof GraphValidationError>[] = [];
			const result: Record<string, unknown> = { ...payload };

			for (const graphField of present) {
				const outcome = enforce(graphField, payload[graphField.field], keys, stored);

				if (outcome.reject) {
					rejections.push(rejection(collection, graphField.field, outcome.reject.blocking, outcome.reject.total, graphField.options));
					continue;
				}

				if (graphField.options.enforcement === 'log' && outcome.errors + outcome.warnings > 0) {
					logger.info(
						{ collection, field: graphField.field, keys, errors: outcome.errors, warnings: outcome.warnings },
						`node-graph (${interfaceId}): graph saved with issues (enforcement: log)`,
					);
				}

				if (outcome.document) setOwn(result, graphField.field, outcome.document);
			}

			if (rejections.length === 1) throw rejections[0];
			// The error handler accepts an array (api/src/middleware/error-handler.ts:27), as processPayload uses.
			if (rejections.length > 1) throw rejections;

			return result;
		}

		async function guardField(
			payload: unknown,
			meta: Record<string, any>,
			context: EventContext,
			isUpdate: boolean,
		): Promise<unknown> {
			// No accountability: schema apply, migrations, internal calls.
			if (!context.accountability || !isPlainObject(payload)) return payload;

			// Two payload shapes reach these filters. FieldsService (Data Model,
			// /fields) passes the Field shape `{ field, type, meta: { interface,
			// options } }` with meta `{ collection }` or `{ keys: [field], collection }`
			// (api/src/services/fields.ts:403-417 and 518-532). CollectionsService
			// creating a collection together with its `fields` (/collections) writes
			// each field's meta row through ItemsService('directus_fields')
			// (api/src/services/collections.ts:168-203), whose filter carries the flat
			// row `{ collection, field, interface, options }` and meta `{ collection:
			// 'directus_fields' }` (keys are row ids on an update).
			const flat = meta['collection'] === 'directus_fields';
			const fieldMeta = flat ? payload : payload['meta'];
			if (!isPlainObject(fieldMeta)) return payload;

			const keys: unknown[] = Array.isArray(meta['keys']) ? meta['keys'] : [];
			const field = typeof payload['field'] === 'string' ? payload['field'] : !flat && keys.length > 0 ? String(keys[0]) : '';

			const collection = flat
				? typeof payload['collection'] === 'string'
					? payload['collection']
					: ''
				: typeof meta['collection'] === 'string'
					? meta['collection']
					: '';

			let usesInterface = fieldMeta['interface'] === interfaceId;

			// An update may carry only the changed options; look up the stored interface then.
			if (!usesInterface && fieldMeta['interface'] === undefined && isUpdate && fieldMeta['options'] !== undefined) {
				try {
					const query = context.database.select('interface').from('directus_fields');
					const rows: Array<{ interface: unknown }> = await (flat ? query.whereIn('id', keys as string[]) : query.where({ collection, field }));
					usesInterface = rows.some((row) => row?.interface === interfaceId);
				} catch (error) {
					// The field may not be ours at all; never fail a field save because of this lookup.
					logger.error(error, `node-graph (${interfaceId}): could not read the stored interface of ${collection}.${field}; not checking the ruleset`);
					return payload;
				}
			}

			if (!usesInterface) return payload;

			// directus_fields.options is json; a client may send it as text.
			const options = parseOptions(fieldMeta['options']);
			if (!isPlainObject(options)) return payload;

			const ruleset = options['ruleset'];

			// Not configured yet is allowed: the editor shows a notice until a ruleset is set.
			if (ruleset === undefined || ruleset === null || ruleset === '') return payload;

			const { problems } = compileRuleset(ruleset);
			if (problems.length === 0) return payload;

			const listed = problems.slice(0, 10).join(' ');
			const more = problems.length > 10 ? ` (${problems.length - 10} more)` : '';

			throw new InvalidPayloadError({
				reason: `The node graph ruleset of "${field}" has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${listed}${more}`.replace(/\.$/, ''),
			});
		}
	};
}

/* ------------------------------------------------------------------------ */
/* Enforcement                                                              */
/* ------------------------------------------------------------------------ */

interface Outcome {
	/** The normalised document with fresh meta and stamp, or null to leave the payload value as it is. */
	document: GraphDocument | null;
	errors: number;
	warnings: number;
	reject: { blocking: Issue[]; total: number } | null;
}

/**
 * Applies one field's policy to one incoming value.
 *
 * - `reject`: any error blocks.
 * - `ratchet`: on update, only errors whose fingerprint the stored value of
 *   every updated item did not already have; on create, or for an item whose
 *   stored value is null, like `reject`.
 * - `log`: never blocks.
 *
 * null clears the field and is always accepted. When normalisation had to
 * drop data and the policy still accepts the value, the payload value is left
 * untouched rather than replaced by the lossy normalised copy.
 */
export function enforce(
	graphField: GraphField,
	raw: unknown,
	keys: PrimaryKey[],
	stored: Map<string, Record<string, unknown>> | null,
): Outcome {
	const report = validateValue(graphField.ruleset, raw);

	if (report.document === null) return { document: null, errors: 0, warnings: 0, reject: null };

	const errors = report.issues.filter((issue) => issue.severity === 'error');
	const warnings = report.issues.length - errors.length;

	let blocking: Issue[] = [];

	if (graphField.options.enforcement === 'reject') {
		blocking = errors;
	} else if (graphField.options.enforcement === 'ratchet') {
		blocking = newErrors(graphField, errors, keys, stored);
	}

	if (blocking.length > 0) {
		return { document: null, errors: errors.length, warnings, reject: { blocking, total: errors.length } };
	}

	// Lossy means normalisation dropped data (normalizeDocument's `fatal` list),
	// which validateValue reports as `invalid_document` issues. A ruleset may set
	// that code to 'off', which hides the issues but must not let the hook store
	// the lossy copy, so the list is read directly in that case.
	const lossy =
		graphField.ruleset?.severities.invalid_document === 'off'
			? normalizeDocument(raw).fatal.length > 0
			: report.issues.some((issue) => issue.code === 'invalid_document');

	if (lossy) return { document: null, errors: errors.length, warnings, reject: null };

	const document: GraphDocument = { ...report.document };
	if (graphField.ruleset) document.ruleset = { key: graphField.ruleset.key, version: graphField.ruleset.version };
	document.meta = computeMeta(graphField.ruleset, document, report.issues);

	return { document, errors: errors.length, warnings, reject: null };
}

/** Errors not present in the stored value of at least one updated item (all errors when there is nothing stored). */
function newErrors(
	graphField: GraphField,
	errors: Issue[],
	keys: PrimaryKey[],
	stored: Map<string, Record<string, unknown>> | null,
): Issue[] {
	if (errors.length === 0) return [];
	if (keys.length === 0 || !stored) return errors;

	// A bulk update often touches many items holding the same graph; validate each distinct value once.
	const seen = new Map<string, Set<string>>();

	const previous = keys.map((key) => {
		const row = stored.get(String(key));
		const value = row ? row[graphField.field] : null;
		if (value === null || value === undefined) return null;

		const text = typeof value === 'string' ? value : JSON.stringify(value);
		let fingerprints = seen.get(text);

		if (!fingerprints) {
			const report = validateValue(graphField.ruleset, value);
			fingerprints = new Set(report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.fingerprint));
			seen.set(text, fingerprints);
		}

		return fingerprints;
	});

	return errors.filter((issue) => previous.some((fingerprints) => !fingerprints || !fingerprints.has(issue.fingerprint)));
}

function rejection(
	collection: string,
	field: string,
	blocking: Issue[],
	total: number,
	options: ResolvedFieldOptions,
): InstanceType<typeof GraphValidationError> {
	const count = `${blocking.length} ${blocking.length === 1 ? 'error' : 'errors'}`;

	const lead =
		options.enforcement === 'ratchet' && blocking.length < total
			? `This change adds ${count} to the graph:`
			: `The graph has ${count}:`;

	const listed = blocking.slice(0, MAX_LISTED_ISSUES).map(describeIssue).join(' ');
	const more = blocking.length > MAX_LISTED_ISSUES ? ` And ${blocking.length - MAX_LISTED_ISSUES} more.` : '';

	return new GraphValidationError({
		collection,
		field,
		path: [],
		type: 'regex',
		validation_message: `${lead} ${listed}${more}`,
		issues: blocking.map((issue) => {
			const entry: GraphValidationExtensions['issues'][number] = { code: issue.code };
			if (issue.nodeId !== undefined) entry.nodeId = issue.nodeId;
			if (issue.edgeId !== undefined) entry.edgeId = issue.edgeId;
			if (issue.port !== undefined) entry.port = issue.port;
			if (issue.field !== undefined) entry.field = issue.field;
			return entry;
		}),
	});
}

/** `"Review": "Title" is required. [field_required, node n_k3x9]` */
function describeIssue(issue: Issue): string {
	const target = issue.nodeId ? `, node ${issue.nodeId}` : issue.edgeId ? `, connection ${issue.edgeId}` : '';
	return `${issue.message} [${issue.code}${target}]`;
}

/* ------------------------------------------------------------------------ */
/* Database                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Stored rows of the updated items (primary key → row with the graph
 * fields), read through the event's database handle.
 */
async function readStored(
	context: EventContext,
	collection: string,
	fields: GraphField[],
	keys: PrimaryKey[],
): Promise<Map<string, Record<string, unknown>>> {
	const primaryKey = context.schema?.collections[collection]?.primary;
	const rows = new Map<string, Record<string, unknown>>();

	// Without a schema there is no safe way to find the rows; ratchet then behaves like reject.
	if (!primaryKey) return rows;

	const columns = [primaryKey, ...fields.map((graphField) => graphField.field)];

	for (let start = 0; start < keys.length; start += KEY_CHUNK_SIZE) {
		const chunk = keys.slice(start, start + KEY_CHUNK_SIZE);
		const result: Array<Record<string, unknown>> = await context.database.select(columns).from(collection).whereIn(primaryKey, chunk);

		for (const row of result) rows.set(String(row[primaryKey]), row);
	}

	return rows;
}

/**
 * `collection → graph fields` for one interface id, from directus_fields.
 * Loaded lazily through whichever database handle the triggering event has
 * (see the header for why), cached for FIELD_MAP_TTL and dropped on
 * `clear()`.
 *
 * A load in flight is shared only with callers that pass the same handle.
 * Sharing it across handles can deadlock on SQLite, whose pool has one
 * connection: an update (filter on the root knex, items.ts:731-746) starts the
 * load and its query waits for the connection, which a create's transaction
 * holds; that create's filter (items.ts:151-168, `database: trx`) then waits
 * for the update's load, and its transaction never ends. Both give up only
 * when knex's acquire timeout fires, and then write without enforcement.
 * `clear()` also forgets loads in flight, so callers after a field change
 * never get a map read before it.
 */
export function createFieldMapCache(interfaceId: string, logger: Logger) {
	let cached: { expires: number; map: FieldMap } | null = null;
	const pending = new Map<Knex, Promise<FieldMap>>();
	let generation = 0;

	async function load(database: Knex): Promise<FieldMap> {
		const rows: Array<{ collection: string; field: string; options: unknown }> = await database
			.select('collection', 'field', 'options')
			.from('directus_fields')
			.where('interface', interfaceId);

		const map: FieldMap = new Map();

		for (const row of rows) {
			const options = resolveFieldOptions(parseOptions(row.options));
			const { ruleset, problems } = options.ruleset === null ? { ruleset: null, problems: ['No ruleset is configured.'] } : compileRuleset(options.ruleset);

			if (!ruleset) {
				logger.warn(
					`node-graph (${interfaceId}): ${row.collection}.${row.field} has no valid ruleset (${problems[0] ?? 'unknown problem'}); only structural checks run`,
				);
			}

			const list = map.get(row.collection) ?? [];
			list.push({ field: row.field, options, ruleset, problems });
			map.set(row.collection, list);
		}

		return map;
	}

	return {
		async get(database: Knex): Promise<FieldMap> {
			if (cached && cached.expires > Date.now()) return cached.map;

			const inFlight = pending.get(database);
			if (inFlight) return inFlight;

			const startedAt = generation;

			const promise = load(database)
				.then((map) => {
					// A clear() during the load means the result may already be stale: use it once, do not cache it.
					if (startedAt === generation) cached = { expires: Date.now() + FIELD_MAP_TTL, map };
					return map;
				})
				.finally(() => {
					if (pending.get(database) === promise) pending.delete(database);
				});

			pending.set(database, promise);
			return promise;
		},

		clear(): void {
			generation++;
			cached = null;
			pending.clear();
		},
	};
}

/** directus_fields.options is a json column: an object on Postgres, text on SQLite and MySQL. */
function parseOptions(value: unknown): unknown {
	if (typeof value !== 'string') return value;

	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
