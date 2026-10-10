/**
 * Compiled rulesets, cached by the raw option value.
 *
 * Every graph field row, every open editor and every table cell of the
 * summary display needs the compiled form of the same `ruleset` option. The
 * tabular layout renders one display per row with the very same
 * `interfaceOptions` object (directus-11.17.4/app/src/layouts/tabular/tabular.vue:150-159),
 * so caching by object identity makes a 100-row table compile once.
 *
 * Objects are keyed by their raw (non-proxied) identity in a WeakMap, so a
 * cached result dies with the options object. Strings (rulesets written
 * through the API as JSON text) go into a small bounded Map.
 */

import { toRaw } from 'vue';
import { compileRuleset, type CompileResult } from '../core';

const objectCache = new WeakMap<object, CompileResult>();
const stringCache = new Map<string, CompileResult>();
const MAX_STRING_ENTRIES = 16;

const EMPTY: CompileResult = Object.freeze({ ruleset: null, problems: ['No ruleset is configured.'] }) as CompileResult;

/**
 * compileRuleset() with a cache. The result is shared: treat it as
 * read-only (CompiledRuleset already is a deep copy that callers must not
 * change).
 */
export function getCompiledRuleset(raw: unknown): CompileResult {
	if (raw === null || raw === undefined) return EMPTY;

	if (typeof raw === 'string') {
		const cached = stringCache.get(raw);
		if (cached) return cached;

		const result = compileRuleset(raw);

		if (stringCache.size >= MAX_STRING_ENTRIES) {
			// Oldest entry first (Map keeps insertion order).
			const oldest = stringCache.keys().next().value;
			if (oldest !== undefined) stringCache.delete(oldest);
		}

		stringCache.set(raw, result);
		return result;
	}

	if (typeof raw === 'object') {
		const key = toRaw(raw);
		const cached = objectCache.get(key);
		if (cached) return cached;

		const result = compileRuleset(key);
		objectCache.set(key, result);
		return result;
	}

	return compileRuleset(raw);
}
