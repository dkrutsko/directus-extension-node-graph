/**
 * Small helpers shared by the core modules. Framework-free and side-effect
 * free; nothing here touches the DOM or Node.
 */

/**
 * Keys that are never read from or written to untrusted JSON. Assigning
 * `__proto__` on a plain object changes its prototype, and `constructor` /
 * `prototype` are the usual stepping stones of prototype-pollution gadgets.
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Keys that content versioning stamps onto every changed plain object of a
 * saved delta, including objects nested inside a JSON field's value
 * (directus-11.17.4/api/src/services/versions.ts:274-283, walker at 423-434).
 * The app edits versions with `versionRaw: true`
 * (directus-11.17.4/app/src/composables/use-item/index.ts:81-86), so the
 * interface can receive them; they are stripped silently at every depth.
 */
export const VERSIONING_KEYS: ReadonlySet<string> = new Set(['_user', '_date']);

/**
 * Names that must never be used as element ids, port keys or ruleset keys:
 * the forbidden keys plus every member of `Object.prototype`. Ids and keys
 * end up as keys of plain objects, in graph libraries and in any code that
 * reads the stored value, and a lookup there resolves inherited members. An
 * index built as `(index[node.id] ||= {})[edge.id] = true` writes the edge id
 * onto Object.prototype for a node id `__proto__`, and a node id
 * `constructor` with an edge id `keys` replaces `Object.keys`. A fixed list
 * (not read from the engine) so the editor and the hook always agree.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
	...FORBIDDEN_KEYS,
	'__defineGetter__',
	'__defineSetter__',
	'__lookupGetter__',
	'__lookupSetter__',
	'hasOwnProperty',
	'isPrototypeOf',
	'propertyIsEnumerable',
	'toLocaleString',
	'toString',
	'valueOf',
]);

/** Ids longer than this are not ids (generated ids are 14 characters). */
export const MAX_ID_LENGTH = 200;

/** A string that can serve as a node or edge id: non-empty, at most MAX_ID_LENGTH characters, not reserved. */
export function isUsableId(value: unknown): value is string {
	return typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH && !RESERVED_NAMES.has(value);
}

/** Deeper values are cut off; real graph data is a handful of levels deep. */
export const MAX_DEPTH = 64;

const hasOwnProperty = Object.prototype.hasOwnProperty;

export function hasOwn(object: object, key: string): boolean {
	return hasOwnProperty.call(object, key);
}

/**
 * True for `{}`-style objects (including Vue reactive proxies of them and
 * null-prototype objects), false for arrays, class instances, dates and the
 * like.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/**
 * Own enumerable string keys, skipping forbidden ones. Every walk over
 * untrusted objects goes through this.
 */
export function safeKeys(object: Record<string, unknown>): string[] {
	return Object.keys(object).filter((key) => !FORBIDDEN_KEYS.has(key));
}

/**
 * Defines an own enumerable property. Unlike `object[key] = value` this can
 * never invoke the `__proto__` setter, so it is safe even if a forbidden key
 * slips through.
 */
export function setOwn(object: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Reads a dotted path (`a.b.0.c`) through own properties of plain objects and
 * indices of arrays only. Forbidden segments and inherited properties resolve
 * to undefined, so a template can never reach `constructor` or a prototype.
 */
export function getPath(scope: unknown, path: string): unknown {
	if (path === '') return undefined;

	let current: unknown = scope;

	for (const segment of path.split('.')) {
		if (segment === '' || FORBIDDEN_KEYS.has(segment)) return undefined;

		if (Array.isArray(current)) {
			if (!/^\d+$/.test(segment)) return undefined;
			current = current[Number(segment)];
		} else if (isPlainObject(current)) {
			if (!hasOwn(current, segment)) return undefined;
			current = current[segment];
		} else {
			return undefined;
		}
	}

	return current;
}

/**
 * Deep copy of JSON-like data. Used for defaults (so two nodes never share a
 * `default_value` object) and for ruleset parts. Values that are not JSON are
 * dropped, forbidden keys are skipped, and depth is capped.
 */
export function cloneJson<T>(value: T, depth = 0): T {
	if (depth > MAX_DEPTH) return null as T;

	if (Array.isArray(value)) {
		return value.map((item) => {
			const cloned = cloneJson(item, depth + 1);
			return cloned === undefined ? null : cloned;
		}) as T;
	}

	if (isPlainObject(value)) {
		const result: Record<string, unknown> = {};

		for (const key of safeKeys(value)) {
			const cloned = cloneJson(value[key], depth + 1);
			if (cloned !== undefined) setOwn(result, key, cloned);
		}

		return result as T;
	}

	if (typeof value === 'number') return (Number.isFinite(value) ? value : null) as T;
	if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;

	return undefined as T;
}

export type SanitizeProblem = 'forbidden_key' | 'too_deep' | 'not_json';

export interface SanitizeOptions {
	/** Drop `_user` / `_date` silently (graph documents, not rulesets). */
	stripVersioningKeys: boolean;
	/** Called once per dropped value with a JS-style path such as `nodes[2].data.label`. */
	report: (path: string, problem: SanitizeProblem) => void;
}

/**
 * Deep copy of untrusted JSON-like data that reports what it drops instead of
 * throwing: forbidden keys, values nested deeper than MAX_DEPTH (replaced by
 * null), and values JSON cannot carry (functions, symbols, bigints, class
 * instances, non-finite numbers; replaced by null in arrays, dropped from
 * objects). Object key order is preserved, which keeps a normalise → save →
 * load → normalise round trip byte-stable.
 */
export function sanitizeJson(value: unknown, path: string, options: SanitizeOptions, depth = 0): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;

	if (typeof value === 'number') {
		if (Number.isFinite(value)) return value;
		options.report(path, 'not_json');
		return null;
	}

	if (depth >= MAX_DEPTH) {
		options.report(path, 'too_deep');
		return null;
	}

	if (Array.isArray(value)) {
		const result: unknown[] = [];

		for (let i = 0; i < value.length; i++) {
			const item = sanitizeJson(value[i], `${path}[${i}]`, options, depth + 1);
			result.push(item === undefined ? null : item);
		}

		return result;
	}

	if (isPlainObject(value)) {
		const result: Record<string, unknown> = {};

		for (const key of Object.keys(value)) {
			const childPath = path === '' ? key : `${path}.${key}`;

			if (FORBIDDEN_KEYS.has(key)) {
				options.report(childPath, 'forbidden_key');
				continue;
			}

			if (options.stripVersioningKeys && VERSIONING_KEYS.has(key)) continue;

			const child = sanitizeJson(value[key], childPath, options, depth + 1);
			if (child !== undefined) setOwn(result, key, child);
		}

		return result;
	}

	if (value !== undefined) options.report(path, 'not_json');
	return undefined;
}

/**
 * A CSS colour that is safe to bind into a style: hex, names, rgb()/hsl(),
 * color-mix() and var(--theme--...). No quotes, `;`, braces or slashes, so no
 * declaration can be smuggled in, and none of the functions that load
 * resources (url(), image(), image-set(), cross-fade(), element(), paint(),
 * src(), expression()) in case a colour ends up in a `background` shorthand.
 */
export function isSafeColor(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
	if (!/^[#A-Za-z0-9(),.%\s_-]+$/.test(value)) return false;
	return !/(?:url|image|image-set|cross-fade|element|paint|src|expression)\s*\(/i.test(value);
}

/**
 * Field key to a readable name, close to what the Directus field editor shows
 * for a field without a name: `due_days` → `Due Days`.
 */
export function formatTitle(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/** Longest untrusted key, type or value echoed into a message. */
export const MAX_ECHO_LENGTH = 60;

/**
 * An untrusted string (a port key, a type key, a format marker) shortened for
 * a message, so a crafted value cannot blow up issue lists and API errors.
 */
export function echo(value: unknown): string {
	return truncate(String(value), MAX_ECHO_LENGTH);
}

/** Shortens text for messages, on a code point boundary, with an ellipsis. */
export function truncate(text: string, max: number): string {
	// A code point is one or two code units, so only the first 2 * max units
	// can matter; this keeps a multi-megabyte string from being split whole.
	if (text.length <= max) return text;

	const chars = Array.from(text.slice(0, max * 2 + 2));
	if (chars.length <= max && text.length <= max * 2 + 2) return text;
	return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Collapses whitespace runs (including newlines) into single spaces and trims. */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}
