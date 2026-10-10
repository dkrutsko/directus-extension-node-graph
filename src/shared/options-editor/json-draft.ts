/**
 * The JSON editor's text, checked while it is typed: does it parse, does it
 * compile, and can the form show it. Framework-free, like view-model.ts.
 */

import { compileRuleset } from '../core/compile';
import { isPlainObject } from '../core/util';
import { stringify, toViewModel } from './view-model';

export interface JsonDraft {
	/** `empty`: no text, which Apply turns into "no ruleset". `invalid`: not a JSON object, cannot be applied. */
	state: 'empty' | 'invalid' | 'ok';
	/** The parsed ruleset when `state` is `ok`. */
	value: Record<string, unknown> | null;
	/** The parse error, or the compiler's problems (which block saving the field, not applying). */
	problems: string[];
	/** Why the form cannot show the ruleset; it can still be applied and saved, and edited here. */
	formReasons: string[];
}

export function inspectJson(text: string): JsonDraft {
	if (text.trim() === '') return { state: 'empty', value: null, problems: [], formReasons: [] };

	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { state: 'invalid', value: null, problems: [`Not valid JSON: ${error instanceof Error ? error.message : 'parse error'}.`], formReasons: [] };
	}

	if (!isPlainObject(parsed)) {
		return { state: 'invalid', value: null, problems: ['The ruleset must be a JSON object ({ … }).'], formReasons: [] };
	}

	const form = toViewModel(parsed);

	return {
		state: 'ok',
		value: parsed,
		problems: compileRuleset(parsed).problems,
		formReasons: form.ok ? [] : form.reasons,
	};
}

/**
 * The stored ruleset as the JSON editor starts it: text written through the
 * API as it is, an object as pretty JSON with tabs (the format of
 * examples/*.json), nothing as an empty editor.
 */
export function rulesetText(raw: unknown): string {
	if (raw === undefined || raw === null) return '';
	if (typeof raw === 'string') return raw;
	return stringify(raw);
}
