/**
 * The ruleset as the options form edits it (the "view model"), and back.
 *
 * The options form (NodeGraphOptions.vue) shows the ruleset with stock
 * Directus interfaces: plain inputs for scalar properties and Repeaters
 * (`list`) for lists. A Repeater edits flat objects, so nested shapes are
 * flattened here and rebuilt by `fromViewModel()`: a node type's
 * `limits.minInstances` becomes `minInstances`, a field's `meta.interface`
 * becomes `interface` (the flat shape of the stock Repeater's "Edit Fields",
 * directus-11.17.4/app/src/interfaces/list/options.vue:23-40), the
 * `severity` map becomes a list of rows, and the starter graph's
 * `position` becomes `x` and `y`.
 *
 * The stored ruleset stays the single source of truth, in exactly the format
 * docs/ruleset.md describes, and the conversion is lossless:
 *
 * - `fromViewModel(vm, base)` with the `vm` and `base` of `toViewModel(r)`
 *   reproduces `r` exactly, key order included. `toViewModel()` checks this
 *   on every load and refuses a ruleset that does not come back unchanged, so
 *   the form never opens on data it would alter.
 * - Every list item carries the stored object it was read from under
 *   `$raw`. The Repeater copies items with all their keys (list.vue:117-131
 *   `openItem`, `saveItem`) and v-form keeps `$`-prefixed keys
 *   (v-form.vue:348-353 `pickKeepMeta`, utils/selective-clone.ts:31-34), so the stored
 *   object travels with its item through edits and reordering.
 *   `fromViewModel()` starts from a copy of it and overlays only the
 *   properties the form manages, so unknown keys, `meta.conditions`,
 *   `meta.sort` and anything else the form does not show survive.
 * - A blank form value (undefined, null, '', [] or {}) means "absent", unless
 *   the stored value was blank too, which is then kept as stored.
 * - A value equal to the documented default is written only when the key
 *   was present before, so a form that shows a default (or a Repeater that
 *   fills one in, list.vue:133-136 `trackEdits`) never adds `deletable: true`
 *   or `typeCheck: 'strict'` to a ruleset that left them out.
 * - New keys go where the format documents them (`ORDER`); existing keys
 *   keep their place.
 *
 * Framework-free (no Vue, no DOM): tests/options-editor.test.ts runs it in
 * Node, and tsconfig.test.json type-checks it without the DOM library.
 */

import { canonicalJson } from '../core/hash';
import { cloneJson, hasOwn, isPlainObject, setOwn } from '../core/util';

type Obj = Record<string, unknown>;

/** A Repeater row or the top-level form model: flat, loosely typed, as the stock interfaces emit it. */
export type ViewItem = Record<string, unknown>;

/** Hidden key that carries a list item's stored object through the Repeater. */
export const RAW_KEY = '$raw';

/**
 * The top-level model of the ruleset form. Every key is a field of that form
 * (form-fields.ts): v-form drops model keys that are not fields when a
 * group-detail section applies its changes (v-form.vue:305-346 `apply`).
 */
export interface RulesetViewModel {
	[key: string]: unknown;
	key?: string | null;
	name?: string | null;
	version?: number | null;
	direction?: string | null;
	dataTypes?: ViewItem[] | null;
	nodeTypes?: ViewItem[] | null;
	edgeTypes?: ViewItem[] | null;
	defaultEdgeType?: string | null;
	typeCheck?: string | null;
	allowSelfLoops?: boolean | null;
	allowCycles?: boolean | null;
	allowMultiEdges?: boolean | null;
	pairMode?: string | null;
	pairRules?: ViewItem[] | null;
	minNodes?: number | null;
	maxNodes?: number | null;
	maxEdges?: number | null;
	entryNodeTypes?: string[] | null;
	requireReachableFromEntry?: boolean | null;
	requireConnected?: boolean | null;
	severity?: ViewItem[] | null;
	starterNodes?: ViewItem[] | null;
	starterEdges?: ViewItem[] | null;
}

/**
 * Where each key goes when the form adds it to an object that did not have
 * it: the order of docs/ruleset.md and examples/approval-workflow.json.
 */
const ORDER = {
	ruleset: ['format', 'schemaVersion', 'key', 'version', 'name', 'direction', 'dataTypes', 'nodeTypes', 'edgeTypes', 'connectionRules', 'graphRules', 'severity', 'starter'],
	dataType: ['key', 'label', 'color', 'accepts'],
	nodeType: ['key', 'label', 'icon', 'color', 'category', 'description', 'deprecated', 'deletable', 'limits', 'titleTemplate', 'summaryFields', 'fields', 'inputs', 'outputs', 'dynamicOutputs'],
	limits: ['minInstances', 'maxInstances'],
	port: ['key', 'label', 'dataType', 'side', 'minConnections', 'maxConnections', 'edgeTypes'],
	dynamicOutputs: ['field', 'labelTemplate', 'placement', 'port'],
	field: ['field', 'name', 'type', 'meta', 'schema'],
	meta: ['interface', 'width', 'required', 'readonly', 'hidden', 'note', 'options', 'display', 'display_options', 'conditions', 'sort'],
	schema: ['default_value'],
	edgeType: ['key', 'label', 'style', 'labelTemplate', 'fields'],
	style: ['path', 'color', 'dashed', 'animated', 'marker'],
	connectionRules: ['defaultEdgeType', 'typeCheck', 'allowSelfLoops', 'allowCycles', 'allowMultiEdges', 'pairs'],
	pairs: ['mode', 'rules'],
	pairRule: ['source', 'sourcePort', 'target', 'targetPort', 'message'],
	graphRules: ['minNodes', 'maxNodes', 'maxEdges', 'entryNodeTypes', 'requireReachableFromEntry', 'requireConnected'],
	starter: ['nodes', 'edges'],
	starterNode: ['ref', 'type', 'position', 'data'],
	position: ['x', 'y'],
	starterEdge: ['source', 'sourceHandle', 'target', 'targetHandle', 'type', 'data'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Documented defaults (docs/ruleset.md) of properties the form shows. The
 * form fields use the same values as `schema.default_value` (form-fields.ts),
 * so what the form shows for an absent key is what the engine assumes.
 */
export const DEFAULTS = {
	version: 1,
	direction: 'LR',
	deprecated: false,
	deletable: true,
	dataType: 'any',
	minConnections: 0,
	placement: 'end',
	path: 'bezier',
	dashed: false,
	animated: false,
	marker: 'arrow',
	typeCheck: 'strict',
	allowSelfLoops: false,
	allowCycles: true,
	allowMultiEdges: false,
	requireReachableFromEntry: false,
	requireConnected: false,
	width: 'full',
	required: false,
	readonly: false,
	hidden: false,
} as const;

/** Port properties as one port's form names them; dynamic outputs use the same settings under other names. */
interface PortNames {
	dataType: string;
	side: string;
	minConnections: string;
	maxConnections: string;
	edgeTypes: string;
	newEdgeType: string;
}

const PORT_NAMES: PortNames = {
	dataType: 'dataType',
	side: 'side',
	minConnections: 'minConnections',
	maxConnections: 'maxConnections',
	edgeTypes: 'edgeTypes',
	newEdgeType: 'newEdgeType',
};

export const DYNAMIC_PORT_NAMES: PortNames = {
	dataType: 'dynamicDataType',
	side: 'dynamicSide',
	minConnections: 'dynamicMinConnections',
	maxConnections: 'dynamicMaxConnections',
	edgeTypes: 'dynamicEdgeTypes',
	newEdgeType: 'dynamicNewEdgeType',
};

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

/** What the form produces for "nothing": undefined, null, '', [] or {}. */
export function isBlank(value: unknown): boolean {
	if (value === undefined || value === null || value === '') return true;
	if (Array.isArray(value)) return value.length === 0;
	return isPlainObject(value) && Object.keys(value).length === 0;
}

/** Same JSON meaning, whatever the key order (forms may rebuild objects in another order). */
function sameJson(a: unknown, b: unknown): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/** Exactly the same JSON, key order included. */
export function sameText(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function rawOf(item: ViewItem): Obj | null {
	const raw = item[RAW_KEY];
	return isPlainObject(raw) ? raw : null;
}

/**
 * Sets `key` on `target`. An existing key is replaced in place; a new one is
 * inserted before the first existing key that `order` puts after it, so
 * added properties land where the format documents them.
 */
function setKey(target: Obj, key: string, value: unknown, order: readonly string[]): void {
	if (hasOwn(target, key)) {
		setOwn(target, key, value);
		return;
	}

	const rank = order.indexOf(key);
	const keys = Object.keys(target);
	const before = rank === -1 ? -1 : keys.findIndex((existing) => order.indexOf(existing) > rank);

	if (before === -1) {
		setOwn(target, key, value);
		return;
	}

	const entries = keys.map((existing) => [existing, target[existing]] as const);
	for (const existing of keys) delete target[existing];

	entries.forEach(([existing, existingValue], index) => {
		if (index === before) setOwn(target, key, value);
		setOwn(target, existing, existingValue);
	});
}

/**
 * Writes one form value into `out` (a copy of `stored`):
 *
 * - blank: removes the key, unless the stored value was blank too;
 * - unchanged (same JSON as stored): keeps the stored value as it was;
 * - equal to `fallback` (the documented default) for a key the stored object
 *   did not have: leaves it out;
 * - otherwise: sets a copy of the value.
 */
function put(out: Obj, stored: Obj | null, key: string, value: unknown, order: readonly string[], fallback?: unknown): void {
	const had = stored !== null && hasOwn(stored, key);

	if (isBlank(value)) {
		if (had && isBlank(stored[key])) return;
		delete out[key];
		return;
	}

	if (had && sameJson(value, stored[key])) return;

	if (!had && fallback !== undefined && sameJson(value, fallback)) {
		delete out[key];
		return;
	}

	setKey(out, key, cloneJson(value), order);
}

/**
 * A nested object (`limits`, `style`, `meta`, `connectionRules`, ...):
 * `build` fills a copy of the stored one. A container left empty is removed,
 * unless it was stored blank (`null` or `{}`); an unchanged one stays as it
 * was.
 */
function container(out: Obj, stored: Obj | null, key: string, order: readonly string[], build: (target: Obj, storedTarget: Obj | null) => void): void {
	const had = stored !== null && hasOwn(stored, key);
	const storedValue = had ? stored[key] : undefined;
	const storedTarget = isPlainObject(storedValue) ? storedValue : null;
	const target: Obj = storedTarget ? cloneJson(storedTarget) : {};

	build(target, storedTarget);

	if (Object.keys(target).length === 0) {
		if (had && isBlank(storedValue)) return;
		delete out[key];
		return;
	}

	if (storedTarget && sameText(target, storedTarget)) return;

	setKey(out, key, target, order);
}

/** A list of objects, each rebuilt from its form row. */
function putList(out: Obj, stored: Obj | null, key: string, rows: unknown, convert: (row: ViewItem) => Obj, order: readonly string[]): void {
	const list = Array.isArray(rows) ? rows.filter(isPlainObject) : [];
	put(out, stored, key, list.length === 0 ? null : list.map(convert), order);
}

/**
 * A multi-select emits its values in the order of its choices
 * (select-multiple-dropdown.vue:33-40 `updateValue`). Keep the stored order
 * for values that stay and append new ones, so an edit changes only what was
 * added or removed.
 */
function keepOrder(stored: unknown, value: unknown): unknown {
	if (!Array.isArray(value) || !Array.isArray(stored)) return value;

	const kept = stored.filter((entry) => value.includes(entry));
	const added = value.filter((entry) => !stored.includes(entry));
	return [...kept, ...added];
}

/**
 * An output's `edgeTypes`: the allowed types are a set, but the first one is
 * the type of new connections. The form shows the set as a multi-select and
 * the first entry as its own select ("New Connections"), and this puts that
 * one first.
 */
function edgeTypeList(stored: unknown, allowed: unknown, first: unknown): unknown {
	if (!Array.isArray(allowed) || allowed.length === 0) return allowed;

	let list = keepOrder(stored, allowed) as unknown[];

	if (typeof first === 'string' && first !== '' && list.includes(first) && list[0] !== first) {
		list = [first, ...list.filter((entry) => entry !== first)];
	}

	return list;
}

/* ------------------------------------------------------------------------ */
/* Default values (field schema.default_value) as text                      */
/* ------------------------------------------------------------------------ */

/**
 * How a stored default value is shown in the "Default Value" input: text as
 * it is, anything else as JSON (`3`, `true`, `["a","b"]`, `{"a":1}`).
 */
export function defaultValueText(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string') return value;
	return JSON.stringify(value);
}

export interface ParsedDefault {
	value: unknown;
	/** Why the text was kept as text although the field type asks for something else. */
	problem?: string;
}

/**
 * Text typed into "Default Value" to the stored `schema.default_value`, by
 * the field's type (documented in docs/ruleset.md, "Fields"):
 *
 * - `boolean`: `true` or `false`;
 * - `integer`, `float`: a number (`integer` only whole numbers);
 * - `json`: JSON (`{"a": 1}`, `["a"]`, `3`, `"text"`);
 * - `csv`: a JSON list, or comma-separated values, as a list of text;
 * - every other type (string, text, bigInteger, decimal, uuid, hash, dates
 *   and times, alias): the text as it is. Directus keeps bigInteger and
 *   decimal values as text in the app to avoid rounding.
 *
 * Text that does not fit the type is stored as text, with a `problem`.
 */
export function parseDefaultValue(text: string, type: unknown): ParsedDefault {
	const trimmed = text.trim();

	switch (type) {
		case 'boolean':
			if (trimmed.toLowerCase() === 'true') return { value: true };
			if (trimmed.toLowerCase() === 'false') return { value: false };
			return { value: text, problem: `"${text}" is not true or false` };

		case 'integer':
			if (/^-?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return { value: Number(trimmed) };
			return { value: text, problem: `"${text}" is not a whole number` };

		case 'float': {
			const number = Number(trimmed);
			if (trimmed !== '' && Number.isFinite(number)) return { value: number };
			return { value: text, problem: `"${text}" is not a number` };
		}

		case 'json':
			try {
				return { value: JSON.parse(text) };
			} catch {
				return { value: text, problem: `"${text}" is not valid JSON` };
			}

		case 'csv': {
			if (trimmed.startsWith('[')) {
				try {
					const parsed: unknown = JSON.parse(trimmed);
					if (Array.isArray(parsed)) return { value: parsed };
				} catch {
					// Not a JSON list: read it as comma-separated text below.
				}
			}

			return {
				value: text
					.split(',')
					.map((entry) => entry.trim())
					.filter((entry) => entry !== ''),
			};
		}

		default:
			return { value: text };
	}
}

/* ------------------------------------------------------------------------ */
/* Ruleset → view model                                                     */
/* ------------------------------------------------------------------------ */

export type ViewModelResult =
	| {
			ok: true;
			vm: RulesetViewModel;
			/** A copy of the stored ruleset, null when there is none: what `fromViewModel()` builds on. */
			base: Obj | null;
			/** The stored ruleset was JSON text (written through the API). */
			fromText: boolean;
	  }
	| {
			ok: false;
			/** Why the form cannot show it, as `path: problem.` lines. */
			reasons: string[];
			/** The stored ruleset as text, for the JSON editor. */
			text: string;
	  };

/**
 * Reads a stored ruleset (object, JSON text, or nothing) into the form's
 * model. Fails, with reasons, when the ruleset is not JSON, not an object,
 * has a value of a shape the form cannot show (a list that is not a list, a
 * flag that is not true or false, ...), or would not come back unchanged.
 * Never throws.
 */
export function toViewModel(raw: unknown): ViewModelResult {
	if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
		return { ok: true, vm: {}, base: null, fromText: false };
	}

	let parsed: unknown = raw;
	const fromText = typeof raw === 'string';

	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			return { ok: false, reasons: [`The ruleset is not valid JSON (${error instanceof Error ? error.message : 'parse error'}).`], text: raw };
		}
	}

	const text = typeof raw === 'string' ? raw : stringify(raw);

	if (!isPlainObject(parsed)) return { ok: false, reasons: ['The ruleset must be a JSON object.'], text };

	try {
		const base = cloneJson(parsed);
		const reader = new Reader();
		const vm = readRuleset(base, reader);

		if (reader.reasons.length > 0) return { ok: false, reasons: reader.reasons, text };

		// The guarantee the form relies on, checked rather than assumed: what
		// the form would write back without any edit is the stored ruleset.
		if (!sameText(fromViewModel(vm, base), parsed)) {
			return {
				ok: false,
				reasons: ['The form cannot show this ruleset without changing it (for example a key such as "__proto__", or values nested too deeply).'],
				text,
			};
		}

		return { ok: true, vm, base, fromText };
	} catch {
		return { ok: false, reasons: ['The ruleset could not be read.'], text };
	}
}

/** Pretty JSON with tabs, the format of examples/*.json. */
export function stringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, '\t') ?? '';
	} catch {
		return '';
	}
}

/**
 * Copies stored values into form rows, checking each has a shape a stock
 * interface can show and give back. Every problem is collected; one is
 * enough for `toViewModel()` to refuse.
 */
class Reader {
	readonly reasons: string[] = [];

	private fail(path: string, message: string): void {
		this.reasons.push(`${path}: ${message}.`);
	}

	/** Text (or null) at `source[key]` into `target[as]`. */
	text(target: ViewItem, as: string, source: Obj, key: string, path: string): void {
		if (!hasOwn(source, key)) return;
		const value = source[key];
		if (value === null || typeof value === 'string') setOwn(target, as, value);
		else this.fail(at(path, key), 'must be text to be edited in the form');
	}

	number(target: ViewItem, as: string, source: Obj, key: string, path: string): void {
		if (!hasOwn(source, key)) return;
		const value = source[key];
		if (value === null || (typeof value === 'number' && Number.isFinite(value))) setOwn(target, as, value);
		else this.fail(at(path, key), 'must be a number to be edited in the form');
	}

	boolean(target: ViewItem, as: string, source: Obj, key: string, path: string): void {
		if (!hasOwn(source, key)) return;
		const value = source[key];
		if (value === null || typeof value === 'boolean') setOwn(target, as, value);
		else this.fail(at(path, key), 'must be true or false to be edited in the form');
	}

	/** A list of text, such as `accepts` or `summaryFields`. */
	texts(target: ViewItem, as: string, source: Obj, key: string, path: string): void {
		if (!hasOwn(source, key)) return;
		const value = source[key];

		if (value === null || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
			setOwn(target, as, cloneJson(value));
		} else {
			this.fail(at(path, key), 'must be a list of text to be edited in the form');
		}
	}

	/** An object (or null), such as interface options. */
	object(target: ViewItem, as: string, source: Obj, key: string, path: string): void {
		if (!hasOwn(source, key)) return;
		const value = source[key];
		if (value === null || isPlainObject(value)) setOwn(target, as, cloneJson(value));
		else this.fail(at(path, key), 'must be an object to be edited in the form');
	}

	/** Any JSON value, such as a starter node's `data`. */
	json(target: ViewItem, as: string, source: Obj, key: string): void {
		if (hasOwn(source, key)) setOwn(target, as, cloneJson(source[key]));
	}

	/** A nested object the form flattens: the object, or null when absent or null. */
	container(source: Obj, key: string, path: string): Obj | null {
		if (!hasOwn(source, key)) return null;
		const value = source[key];
		if (value === null || isPlainObject(value)) return value;
		this.fail(at(path, key), 'must be an object to be edited in the form');
		return null;
	}

	/**
	 * A list of objects into `target[as]` as rows. A stored `null` becomes a
	 * `null` model value, which `fromViewModel()` keeps as `null`.
	 */
	list(target: ViewItem, as: string, source: Obj, key: string, path: string, read: (item: Obj, path: string) => ViewItem): void {
		if (!hasOwn(source, key)) return;
		const value = source[key];

		if (value === null) {
			setOwn(target, as, null);
			return;
		}

		if (!Array.isArray(value)) {
			this.fail(at(path, key), 'must be a list to be edited in the form');
			return;
		}

		const rows: ViewItem[] = [];

		value.forEach((item, index) => {
			const itemPath = `${at(path, key)}[${index}]`;
			if (isPlainObject(item)) rows.push(read(item, itemPath));
			else this.fail(itemPath, 'must be an object to be edited in the form');
		});

		setOwn(target, as, rows);
	}
}

function at(path: string, key: string): string {
	return path === '' ? key : `${path}.${key}`;
}

function row(raw: Obj): ViewItem {
	const item: ViewItem = {};
	setOwn(item, RAW_KEY, raw);
	return item;
}

function readRuleset(base: Obj, r: Reader): RulesetViewModel {
	const vm: RulesetViewModel = {};

	r.text(vm, 'key', base, 'key', '');
	r.text(vm, 'name', base, 'name', '');
	r.number(vm, 'version', base, 'version', '');
	r.text(vm, 'direction', base, 'direction', '');

	r.list(vm, 'dataTypes', base, 'dataTypes', '', (item, path) => readDataType(item, path, r));
	r.list(vm, 'nodeTypes', base, 'nodeTypes', '', (item, path) => readNodeType(item, path, r));
	r.list(vm, 'edgeTypes', base, 'edgeTypes', '', (item, path) => readEdgeType(item, path, r));

	const rules = r.container(base, 'connectionRules', '');

	if (rules) {
		r.text(vm, 'defaultEdgeType', rules, 'defaultEdgeType', 'connectionRules');
		r.text(vm, 'typeCheck', rules, 'typeCheck', 'connectionRules');
		r.boolean(vm, 'allowSelfLoops', rules, 'allowSelfLoops', 'connectionRules');
		r.boolean(vm, 'allowCycles', rules, 'allowCycles', 'connectionRules');
		r.boolean(vm, 'allowMultiEdges', rules, 'allowMultiEdges', 'connectionRules');

		const pairs = r.container(rules, 'pairs', 'connectionRules');

		if (pairs) {
			r.text(vm, 'pairMode', pairs, 'mode', 'connectionRules.pairs');
			r.list(vm, 'pairRules', pairs, 'rules', 'connectionRules.pairs', (item, path) => readPairRule(item, path, r));
		}
	}

	const graph = r.container(base, 'graphRules', '');

	if (graph) {
		r.number(vm, 'minNodes', graph, 'minNodes', 'graphRules');
		r.number(vm, 'maxNodes', graph, 'maxNodes', 'graphRules');
		r.number(vm, 'maxEdges', graph, 'maxEdges', 'graphRules');
		r.texts(vm, 'entryNodeTypes', graph, 'entryNodeTypes', 'graphRules');
		r.boolean(vm, 'requireReachableFromEntry', graph, 'requireReachableFromEntry', 'graphRules');
		r.boolean(vm, 'requireConnected', graph, 'requireConnected', 'graphRules');
	}

	if (hasOwn(base, 'severity')) {
		const severity = r.container(base, 'severity', '');

		if (severity) {
			// Rows without `$raw`: a row is just its code and level, rebuilt into the map in row order.
			vm.severity = Object.keys(severity).map((code) => {
				const rowValue: ViewItem = { code };
				r.text(rowValue, 'severity', severity, code, 'severity');
				return rowValue;
			});
		} else if (base['severity'] === null) {
			vm.severity = null;
		}
	}

	const starter = r.container(base, 'starter', '');

	if (starter) {
		r.list(vm, 'starterNodes', starter, 'nodes', 'starter', (item, path) => readStarterNode(item, path, r));
		r.list(vm, 'starterEdges', starter, 'edges', 'starter', (item, path) => readStarterEdge(item, path, r));
	}

	return vm;
}

function readDataType(raw: Obj, path: string, r: Reader): ViewItem {
	const item = row(raw);
	r.text(item, 'key', raw, 'key', path);
	r.text(item, 'label', raw, 'label', path);
	r.text(item, 'color', raw, 'color', path);
	r.texts(item, 'accepts', raw, 'accepts', path);
	return item;
}

function readNodeType(raw: Obj, path: string, r: Reader): ViewItem {
	const item = row(raw);

	for (const key of ['key', 'label', 'icon', 'color', 'category', 'description']) r.text(item, key, raw, key, path);

	r.boolean(item, 'deprecated', raw, 'deprecated', path);
	r.boolean(item, 'deletable', raw, 'deletable', path);

	const limits = r.container(raw, 'limits', path);

	if (limits) {
		r.number(item, 'minInstances', limits, 'minInstances', at(path, 'limits'));
		r.number(item, 'maxInstances', limits, 'maxInstances', at(path, 'limits'));
	}

	r.text(item, 'titleTemplate', raw, 'titleTemplate', path);
	r.texts(item, 'summaryFields', raw, 'summaryFields', path);
	r.list(item, 'fields', raw, 'fields', path, (field, fieldPath) => readField(field, fieldPath, r));
	r.list(item, 'inputs', raw, 'inputs', path, (port, portPath) => readPort(port, portPath, 'input', r));
	r.list(item, 'outputs', raw, 'outputs', path, (port, portPath) => readPort(port, portPath, 'output', r));

	const dynamic = r.container(raw, 'dynamicOutputs', path);

	if (dynamic) {
		const dynamicPath = at(path, 'dynamicOutputs');
		r.text(item, 'dynamicField', dynamic, 'field', dynamicPath);
		r.text(item, 'dynamicLabelTemplate', dynamic, 'labelTemplate', dynamicPath);
		r.text(item, 'dynamicPlacement', dynamic, 'placement', dynamicPath);

		const port = r.container(dynamic, 'port', dynamicPath);
		if (port) readPortSettings(item, port, at(dynamicPath, 'port'), DYNAMIC_PORT_NAMES, true, r);
	}

	return item;
}

function readPort(raw: Obj, path: string, direction: 'input' | 'output', r: Reader): ViewItem {
	const item = row(raw);
	r.text(item, 'key', raw, 'key', path);
	r.text(item, 'label', raw, 'label', path);
	// An input's `edgeTypes` (a compile error) is not shown; it stays in `$raw`.
	readPortSettings(item, raw, path, PORT_NAMES, direction === 'output', r);
	return item;
}

function readPortSettings(item: ViewItem, source: Obj, path: string, names: PortNames, output: boolean, r: Reader): void {
	r.text(item, names.dataType, source, 'dataType', path);
	r.text(item, names.side, source, 'side', path);
	r.number(item, names.minConnections, source, 'minConnections', path);
	r.number(item, names.maxConnections, source, 'maxConnections', path);

	if (!output) return;

	r.texts(item, names.edgeTypes, source, 'edgeTypes', path);

	const edgeTypes = item[names.edgeTypes];
	if (Array.isArray(edgeTypes) && typeof edgeTypes[0] === 'string') setOwn(item, names.newEdgeType, edgeTypes[0]);
}

/**
 * A NodeGraphField as a row of the "Fields" Repeater: `meta.*` next to the
 * key, name and type, the way the stock Repeater's "Edit Fields" flattens
 * Directus fields (list/options.vue:23-40), and the default value as text
 * (`defaultValueText`). `fieldFromRow()` is the inverse.
 */
export function fieldToRow(field: unknown): ViewItem {
	return isPlainObject(field) ? readField(cloneJson(field), 'field', new Reader()) : {};
}

function readField(raw: Obj, path: string, r: Reader): ViewItem {
	const item = row(raw);
	r.text(item, 'field', raw, 'field', path);
	r.text(item, 'name', raw, 'name', path);
	r.text(item, 'type', raw, 'type', path);

	const meta = r.container(raw, 'meta', path);

	if (meta) {
		const metaPath = at(path, 'meta');
		r.text(item, 'interface', meta, 'interface', metaPath);
		r.object(item, 'options', meta, 'options', metaPath);
		r.text(item, 'display', meta, 'display', metaPath);
		r.object(item, 'display_options', meta, 'display_options', metaPath);
		r.text(item, 'width', meta, 'width', metaPath);
		r.boolean(item, 'required', meta, 'required', metaPath);
		r.boolean(item, 'readonly', meta, 'readonly', metaPath);
		r.boolean(item, 'hidden', meta, 'hidden', metaPath);
		r.text(item, 'note', meta, 'note', metaPath);
	}

	const schema = r.container(raw, 'schema', path);

	if (schema && hasOwn(schema, 'default_value')) setOwn(item, 'defaultValue', defaultValueText(schema['default_value']));

	return item;
}

function readEdgeType(raw: Obj, path: string, r: Reader): ViewItem {
	const item = row(raw);
	r.text(item, 'key', raw, 'key', path);
	r.text(item, 'label', raw, 'label', path);

	const style = r.container(raw, 'style', path);

	if (style) {
		const stylePath = at(path, 'style');
		r.text(item, 'path', style, 'path', stylePath);
		r.text(item, 'color', style, 'color', stylePath);
		r.boolean(item, 'dashed', style, 'dashed', stylePath);
		r.boolean(item, 'animated', style, 'animated', stylePath);
		r.text(item, 'marker', style, 'marker', stylePath);
	}

	r.text(item, 'labelTemplate', raw, 'labelTemplate', path);
	r.list(item, 'fields', raw, 'fields', path, (field, fieldPath) => readField(field, fieldPath, r));
	return item;
}

function readPairRule(raw: Obj, path: string, r: Reader): ViewItem {
	const item = row(raw);
	for (const key of ORDER.pairRule) r.text(item, key, raw, key, path);
	return item;
}

function readStarterNode(raw: Obj, path: string, r: Reader): ViewItem {
	const item = row(raw);
	r.text(item, 'ref', raw, 'ref', path);
	r.text(item, 'type', raw, 'type', path);

	const position = r.container(raw, 'position', path);

	if (position) {
		r.number(item, 'x', position, 'x', at(path, 'position'));
		r.number(item, 'y', position, 'y', at(path, 'position'));
	}

	r.json(item, 'data', raw, 'data');
	return item;
}

function readStarterEdge(raw: Obj, path: string, r: Reader): ViewItem {
	const item = row(raw);
	for (const key of ['source', 'sourceHandle', 'target', 'targetHandle', 'type']) r.text(item, key, raw, key, path);
	r.json(item, 'data', raw, 'data');
	return item;
}

/* ------------------------------------------------------------------------ */
/* View model → ruleset                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Rebuilds the ruleset from the form's model. `base` is the stored ruleset
 * the model was read from (`toViewModel().base`), or null for a new one;
 * it is never changed. Returns a new object, `{}` when the form is empty.
 */
export function fromViewModel(vm: RulesetViewModel, base: Obj | null): Obj {
	const out: Obj = base ? cloneJson(base) : {};
	const order = ORDER.ruleset;

	put(out, base, 'key', vm.key, order);
	put(out, base, 'version', vm.version, order, DEFAULTS.version);
	put(out, base, 'name', vm.name, order);
	put(out, base, 'direction', vm.direction, order, DEFAULTS.direction);

	putList(out, base, 'dataTypes', vm.dataTypes, dataTypeFromRow, order);
	putList(out, base, 'nodeTypes', vm.nodeTypes, nodeTypeFromRow, order);
	putList(out, base, 'edgeTypes', vm.edgeTypes, edgeTypeFromRow, order);

	container(out, base, 'connectionRules', order, (rules, storedRules) => {
		const ruleOrder = ORDER.connectionRules;
		put(rules, storedRules, 'defaultEdgeType', vm.defaultEdgeType, ruleOrder);
		put(rules, storedRules, 'typeCheck', vm.typeCheck, ruleOrder, DEFAULTS.typeCheck);
		put(rules, storedRules, 'allowSelfLoops', vm.allowSelfLoops, ruleOrder, DEFAULTS.allowSelfLoops);
		put(rules, storedRules, 'allowCycles', vm.allowCycles, ruleOrder, DEFAULTS.allowCycles);
		put(rules, storedRules, 'allowMultiEdges', vm.allowMultiEdges, ruleOrder, DEFAULTS.allowMultiEdges);

		container(rules, storedRules, 'pairs', ruleOrder, (pairs, storedPairs) => {
			put(pairs, storedPairs, 'mode', vm.pairMode, ORDER.pairs);
			putList(pairs, storedPairs, 'rules', vm.pairRules, pairRuleFromRow, ORDER.pairs);

			// `rules` is required once there are pair rules at all; a mode picked before the first rule gets an empty list.
			if (storedPairs === null && Object.keys(pairs).length > 0 && !hasOwn(pairs, 'rules')) setKey(pairs, 'rules', [], ORDER.pairs);
		});
	});

	container(out, base, 'graphRules', order, (graph, storedGraph) => {
		const graphOrder = ORDER.graphRules;
		put(graph, storedGraph, 'minNodes', vm.minNodes, graphOrder);
		put(graph, storedGraph, 'maxNodes', vm.maxNodes, graphOrder);
		put(graph, storedGraph, 'maxEdges', vm.maxEdges, graphOrder);
		put(graph, storedGraph, 'entryNodeTypes', keepOrder(storedGraph?.['entryNodeTypes'], vm.entryNodeTypes), graphOrder);
		put(graph, storedGraph, 'requireReachableFromEntry', vm.requireReachableFromEntry, graphOrder, DEFAULTS.requireReachableFromEntry);
		put(graph, storedGraph, 'requireConnected', vm.requireConnected, graphOrder, DEFAULTS.requireConnected);
	});

	put(out, base, 'severity', severityFromRows(vm.severity), order);

	container(out, base, 'starter', order, (starter, storedStarter) => {
		putList(starter, storedStarter, 'nodes', vm.starterNodes, starterNodeFromRow, ORDER.starter);
		putList(starter, storedStarter, 'edges', vm.starterEdges, starterEdgeFromRow, ORDER.starter);
	});

	return out;
}

function startFrom(item: ViewItem): { out: Obj; stored: Obj | null } {
	const stored = rawOf(item);
	return { out: stored ? cloneJson(stored) : {}, stored };
}

function dataTypeFromRow(item: ViewItem): Obj {
	const { out, stored } = startFrom(item);
	const order = ORDER.dataType;
	put(out, stored, 'key', item['key'], order);
	put(out, stored, 'label', item['label'], order);
	put(out, stored, 'color', item['color'], order);
	put(out, stored, 'accepts', keepOrder(stored?.['accepts'], item['accepts']), order);
	return out;
}

function nodeTypeFromRow(item: ViewItem): Obj {
	const { out, stored } = startFrom(item);
	const order = ORDER.nodeType;

	for (const key of ['key', 'label', 'icon', 'color', 'category', 'description']) put(out, stored, key, item[key], order);

	put(out, stored, 'deprecated', item['deprecated'], order, DEFAULTS.deprecated);
	put(out, stored, 'deletable', item['deletable'], order, DEFAULTS.deletable);

	container(out, stored, 'limits', order, (limits, storedLimits) => {
		put(limits, storedLimits, 'minInstances', item['minInstances'], ORDER.limits);
		put(limits, storedLimits, 'maxInstances', item['maxInstances'], ORDER.limits);
	});

	put(out, stored, 'titleTemplate', item['titleTemplate'], order);
	put(out, stored, 'summaryFields', item['summaryFields'], order);
	putList(out, stored, 'fields', item['fields'], fieldFromRow, order);
	putList(out, stored, 'inputs', item['inputs'], (port) => portFromRow(port, 'input'), order);
	putList(out, stored, 'outputs', item['outputs'], (port) => portFromRow(port, 'output'), order);

	container(out, stored, 'dynamicOutputs', order, (dynamic, storedDynamic) => {
		const dynamicOrder = ORDER.dynamicOutputs;
		put(dynamic, storedDynamic, 'field', item['dynamicField'], dynamicOrder);
		put(dynamic, storedDynamic, 'labelTemplate', item['dynamicLabelTemplate'], dynamicOrder);
		put(dynamic, storedDynamic, 'placement', item['dynamicPlacement'], dynamicOrder, DEFAULTS.placement);

		container(dynamic, storedDynamic, 'port', dynamicOrder, (port, storedPort) => {
			putPortSettings(port, storedPort, item, DYNAMIC_PORT_NAMES, true);
		});
	});

	return out;
}

function portFromRow(item: ViewItem, direction: 'input' | 'output'): Obj {
	const { out, stored } = startFrom(item);
	put(out, stored, 'key', item['key'], ORDER.port);
	put(out, stored, 'label', item['label'], ORDER.port);
	putPortSettings(out, stored, item, PORT_NAMES, direction === 'output');
	return out;
}

function putPortSettings(out: Obj, stored: Obj | null, item: ViewItem, names: PortNames, output: boolean): void {
	const order = ORDER.port;
	put(out, stored, 'dataType', item[names.dataType], order, DEFAULTS.dataType);
	put(out, stored, 'side', item[names.side], order);
	put(out, stored, 'minConnections', item[names.minConnections], order, DEFAULTS.minConnections);
	put(out, stored, 'maxConnections', item[names.maxConnections], order);

	if (output) put(out, stored, 'edgeTypes', edgeTypeList(stored?.['edgeTypes'], item[names.edgeTypes], item[names.newEdgeType]), order);
}

/**
 * A form row of the "Fields" Repeater back to a NodeGraphField: key, name and
 * type at the top, the rest under `meta`, the default value under
 * `schema.default_value` (parsed by type, `parseDefaultValue`). Keys of the
 * stored `meta` and `schema` that the form does not show are kept.
 */
export function fieldFromRow(item: ViewItem): Obj {
	const { out, stored } = startFrom(item);
	const order = ORDER.field;

	put(out, stored, 'field', item['field'], order);
	put(out, stored, 'name', item['name'], order);
	put(out, stored, 'type', item['type'], order);

	container(out, stored, 'meta', order, (meta, storedMeta) => {
		const metaOrder = ORDER.meta;
		put(meta, storedMeta, 'interface', item['interface'], metaOrder);
		put(meta, storedMeta, 'width', item['width'], metaOrder, DEFAULTS.width);
		put(meta, storedMeta, 'required', item['required'], metaOrder, DEFAULTS.required);
		put(meta, storedMeta, 'readonly', item['readonly'], metaOrder, DEFAULTS.readonly);
		put(meta, storedMeta, 'hidden', item['hidden'], metaOrder, DEFAULTS.hidden);
		put(meta, storedMeta, 'note', item['note'], metaOrder);
		put(meta, storedMeta, 'options', item['options'], metaOrder);
		put(meta, storedMeta, 'display', item['display'], metaOrder);
		put(meta, storedMeta, 'display_options', item['display_options'], metaOrder);
	});

	container(out, stored, 'schema', order, (schema, storedSchema) => {
		const text = item['defaultValue'];
		const had = storedSchema !== null && hasOwn(storedSchema, 'default_value');

		if (text === undefined || text === null || text === '') {
			// A stored `null` or `""` default shows as an empty input; keep it.
			if (had && (storedSchema['default_value'] === null || storedSchema['default_value'] === '')) return;
			delete schema['default_value'];
			return;
		}

		const value = String(text);
		if (had && value === defaultValueText(storedSchema['default_value'])) return;

		setKey(schema, 'default_value', parseDefaultValue(value, item['type']).value, ORDER.schema);
	});

	return out;
}

function edgeTypeFromRow(item: ViewItem): Obj {
	const { out, stored } = startFrom(item);
	const order = ORDER.edgeType;

	put(out, stored, 'key', item['key'], order);
	put(out, stored, 'label', item['label'], order);

	container(out, stored, 'style', order, (style, storedStyle) => {
		const styleOrder = ORDER.style;
		put(style, storedStyle, 'path', item['path'], styleOrder, DEFAULTS.path);
		put(style, storedStyle, 'color', item['color'], styleOrder);
		put(style, storedStyle, 'dashed', item['dashed'], styleOrder, DEFAULTS.dashed);
		put(style, storedStyle, 'animated', item['animated'], styleOrder, DEFAULTS.animated);
		put(style, storedStyle, 'marker', item['marker'], styleOrder, DEFAULTS.marker);
	});

	put(out, stored, 'labelTemplate', item['labelTemplate'], order);
	putList(out, stored, 'fields', item['fields'], fieldFromRow, order);
	return out;
}

function pairRuleFromRow(item: ViewItem): Obj {
	const { out, stored } = startFrom(item);
	for (const key of ORDER.pairRule) put(out, stored, key, item[key], ORDER.pairRule);
	return out;
}

/**
 * Severity rows back to the `severity` map, in row order. A row without an
 * issue code cannot be stored (there is no key to store it under) and is
 * reported by `viewModelNotes()`; a row with a code but no severity is
 * stored as `null`, so it is kept and the compiler explains it.
 */
function severityFromRows(rows: unknown): Obj | null {
	if (!Array.isArray(rows)) return null;

	const map: Obj = {};

	for (const entry of rows) {
		if (!isPlainObject(entry)) continue;

		const code = entry['code'];
		if (typeof code !== 'string' || code === '') continue;

		const level = entry['severity'];
		setOwn(map, code, isBlank(level) ? null : level);
	}

	return Object.keys(map).length === 0 ? null : map;
}

function starterNodeFromRow(item: ViewItem): Obj {
	const { out, stored } = startFrom(item);
	const order = ORDER.starterNode;

	put(out, stored, 'ref', item['ref'], order);
	put(out, stored, 'type', item['type'], order);

	container(out, stored, 'position', order, (position, storedPosition) => {
		put(position, storedPosition, 'x', item['x'], ORDER.position);
		put(position, storedPosition, 'y', item['y'], ORDER.position);
	});

	put(out, stored, 'data', item['data'], order);
	return out;
}

function starterEdgeFromRow(item: ViewItem): Obj {
	const { out, stored } = startFrom(item);
	for (const key of ORDER.starterEdge) put(out, stored, key, item[key], ORDER.starterEdge);
	return out;
}

/* ------------------------------------------------------------------------ */
/* Notes about the model                                                    */
/* ------------------------------------------------------------------------ */

/**
 * What the form holds that the ruleset cannot store as entered, for the
 * notice under the problems: severity rows without an issue code (kept in
 * the form, but not saved), codes listed twice (the last row wins), and
 * default values that do not fit their field type (saved as text). The
 * compiler's problems cover everything that is stored.
 */
export function viewModelNotes(vm: RulesetViewModel): string[] {
	const notes: string[] = [];
	const rows = Array.isArray(vm.severity) ? vm.severity : [];
	const counts = new Map<string, number>();

	rows.forEach((entry, index) => {
		const code = isPlainObject(entry) ? entry['code'] : undefined;

		if (typeof code !== 'string' || code === '') {
			notes.push(`Severity Overrides, row ${index + 1}: choose an issue code. The row is not saved until it has one.`);
		} else {
			counts.set(code, (counts.get(code) ?? 0) + 1);
		}
	});

	for (const [code, count] of counts) {
		if (count > 1) notes.push(`Severity Overrides: "${code}" is listed ${count} times; only the last row counts.`);
	}

	const checkFields = (owner: string, fields: unknown) => {
		if (!Array.isArray(fields)) return;

		for (const field of fields) {
			if (!isPlainObject(field)) continue;

			const text = field['defaultValue'];
			if (typeof text !== 'string' || text === '') continue;

			// An unchanged stored default is kept as stored, whatever its type.
			const stored = rawOf(field);
			const storedSchema = stored && isPlainObject(stored['schema']) ? stored['schema'] : null;
			if (storedSchema && hasOwn(storedSchema, 'default_value') && defaultValueText(storedSchema['default_value']) === text) continue;

			const { problem } = parseDefaultValue(text, field['type']);
			if (problem) notes.push(`${owner}, field "${String(field['field'] ?? '?')}": the default value ${problem}; it is saved as text.`);
		}
	};

	(Array.isArray(vm.nodeTypes) ? vm.nodeTypes : []).forEach((nodeType, index) => {
		if (isPlainObject(nodeType)) checkFields(`Node type "${String(nodeType['key'] || `#${index + 1}`)}"`, nodeType['fields']);
	});

	(Array.isArray(vm.edgeTypes) ? vm.edgeTypes : []).forEach((edgeType, index) => {
		if (isPlainObject(edgeType)) checkFields(`Edge type "${String(edgeType['key'] || `#${index + 1}`)}"`, edgeType['fields']);
	});

	return notes;
}
