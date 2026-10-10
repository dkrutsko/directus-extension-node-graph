/**
 * `{{ token }}` templates for node titles, edge labels, dynamic port labels
 * and the field summary.
 *
 * The syntax matches what Directus admins already write in display templates
 * (`{{ field }}`, `{{ a.b }}`), but the renderer is our own: it is plain text
 * only, resolves paths through own properties (getPath), and never evaluates
 * anything. The output must be rendered as text (Vue `{{ }}`, `textContent`,
 * SVG text nodes), never as HTML; nothing here escapes or produces markup.
 */

import { asReference, referenceText } from './references';
import type { NodeGraphField, ReferenceResolver } from './types';
import { getPath, isPlainObject } from './util';

/** `{{ path }}` with optional inner whitespace. The path itself is checked separately. */
const TOKEN_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Field keys, `$type`, dotted paths and array indices. */
const PATH_PATTERN = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;

/** C0 controls except tab and newline, and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface TemplateResult {
	text: string;
	/** Number of tokens in the template. */
	tokens: number;
	/** Number of tokens that rendered a non-empty value. */
	filled: number;
}

/**
 * Renders `template` against `scope`. Missing values render as empty. When
 * `fields` are given, a token whose first path segment names one of them is
 * formatted like the form shows it: choice text for select interfaces
 * (`meta.options.choices`), Yes/No for booleans, arrays joined with ", ".
 * Item references (references.ts) render as their display text from
 * `references`, or as their key.
 */
export function renderTemplate(
	template: string | null | undefined,
	scope: unknown,
	fields?: readonly NodeGraphField[] | null,
	references?: ReferenceResolver | null,
): string {
	return renderTemplateDetailed(template, scope, fields, references).text;
}

/** renderTemplate plus token counts, so callers can tell "all tokens were empty" apart. */
export function renderTemplateDetailed(
	template: string | null | undefined,
	scope: unknown,
	fields?: readonly NodeGraphField[] | null,
	references?: ReferenceResolver | null,
): TemplateResult {
	if (typeof template !== 'string' || template === '') return { text: '', tokens: 0, filled: 0 };

	let tokens = 0;
	let filled = 0;

	const text = template.replace(TOKEN_PATTERN, (_match, rawPath: string) => {
		tokens++;

		const path = rawPath.trim();
		if (!PATH_PATTERN.test(path)) return '';

		const field = fields ? findField(fields, path.split('.')[0]!) : undefined;
		const rendered = formatValue(getPath(scope, path), field, fields != null, references);

		if (rendered !== '') filled++;
		return rendered;
	});

	return { text: text.replace(CONTROL_CHARACTERS, ''), tokens, filled };
}

/**
 * The paths a template reads, in order and without duplicates; tokens that
 * are not valid paths (and so always render empty) are left out. The editor
 * uses it to ask the API for exactly the fields a display template needs.
 */
export function templatePaths(template: string | null | undefined): string[] {
	if (typeof template !== 'string') return [];

	const paths = new Set<string>();

	for (const match of template.matchAll(TOKEN_PATTERN)) {
		const path = match[1]!.trim();
		if (PATH_PATTERN.test(path)) paths.add(path);
	}

	return [...paths];
}

function findField(fields: readonly NodeGraphField[], key: string): NodeGraphField | undefined {
	for (const field of fields) {
		if (field && field.field === key) return field;
	}

	return undefined;
}

/**
 * Nested lists deeper than this render as empty. A select-multiple value is
 * one level deep; the cap keeps a cyclic or absurdly deep array (a value that
 * never went through normalizeDocument) from overflowing the stack.
 */
const MAX_LIST_DEPTH = 8;

/**
 * One value as plain text. Objects render as empty: their structure is not
 * meant for titles, and dumping JSON would leak data the admin did not ask to
 * show. The exception is an item reference (`{ key, collection }`, see
 * references.ts), which renders as the referenced item's display text from
 * `references`, or as its key when the resolver does not know it or there is
 * none (the hook and the display); a list of them is joined with ", ".
 */
export function formatValue(value: unknown, field?: NodeGraphField, friendly = true, references?: ReferenceResolver | null): string {
	return formatValueAt(value, field, friendly, 0, references);
}

function formatValueAt(
	value: unknown,
	field: NodeGraphField | undefined,
	friendly: boolean,
	depth: number,
	references: ReferenceResolver | null | undefined,
): string {
	if (value === null || value === undefined) return '';

	if (Array.isArray(value)) {
		if (depth >= MAX_LIST_DEPTH) return '';

		return value
			.map((item) => formatValueAt(item, field, friendly, depth + 1, references))
			.filter((item) => item !== '')
			.join(', ');
	}

	if (typeof value === 'object') {
		const reference = asReference(value, field);
		return reference ? referenceText(reference, field, references) : '';
	}

	if (typeof value === 'boolean') {
		const choice = choiceText(field, value);
		if (choice !== null) return choice;
		return friendly ? (value ? 'Yes' : 'No') : String(value);
	}

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
		const choice = choiceText(field, value);
		if (choice !== null) return choice;
		if (typeof value === 'number' && !Number.isFinite(value)) return '';
		return String(value);
	}

	return '';
}

/** Text of the matching `meta.options.choices` entry, or null. Values compare as strings, as the select interfaces do. */
function choiceText(field: NodeGraphField | undefined, value: string | number | bigint | boolean): string | null {
	const choices = field?.meta?.options?.['choices'];
	if (!Array.isArray(choices)) return null;

	for (const choice of choices) {
		if (!isPlainObject(choice)) continue;

		const choiceValue = choice['value'];
		if (choiceValue === null || choiceValue === undefined) continue;

		if (String(choiceValue) === String(value)) {
			const text = choice['text'];
			return typeof text === 'string' && text !== '' ? text : String(value);
		}
	}

	return null;
}
