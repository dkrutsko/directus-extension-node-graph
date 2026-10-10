/**
 * The text a node-graph field shows in list views: the same fieldSummary()
 * the field row uses, from the field's own interface options (its ruleset
 * and summary template).
 *
 * Displays receive the field's interface options as `interfaceOptions` in
 * 11.17.4 wherever the app renders them through RenderDisplay or
 * RenderTemplate (directus-11.17.4/app/src/views/private/components/render-display.vue:8-17,
 * render-template.vue:115-128; the tabular layout passes them at
 * app/src/layouts/tabular/tabular.vue:150-159), and display handlers get
 * them in their context (packages/types DisplayConfig `handler`). So the
 * display needs no options of its own.
 */

import { fieldSummary, validateValue, type GraphMeta } from '../core';
import { isPlainObject } from '../core/util';
import { resolveFieldOptions } from '../options';
import { getCompiledRuleset } from '../ui/ruleset-cache';

export interface DisplaySummary {
	text: string;
	errorCount: number;
	warningCount: number;
}

/**
 * Summary of a raw field value, or null for an empty field. Validates
 * against the field's ruleset when it compiles; otherwise falls back to the
 * stored `meta` counts (written by the editor and the hook) for the issue
 * icon.
 */
export function displaySummary(value: unknown, interfaceOptions: unknown): DisplaySummary | null {
	if (value === null || value === undefined || value === '') return null;

	const options = resolveFieldOptions(interfaceOptions);
	const { ruleset } = getCompiledRuleset(options.ruleset);
	const report = validateValue(ruleset, value);

	if (!report.document) return null;

	let errorCount = 0;
	let warningCount = 0;

	if (ruleset) {
		for (const issue of report.issues) {
			if (issue.severity === 'error') errorCount++;
			else warningCount++;
		}
	} else {
		const meta = isPlainObject(value) && isPlainObject(value['meta']) ? (value['meta'] as Partial<GraphMeta>) : null;
		errorCount = typeof meta?.errorCount === 'number' ? meta.errorCount : 0;
		warningCount = typeof meta?.warningCount === 'number' ? meta.warningCount : 0;
	}

	return {
		text: fieldSummary({ template: options.template }, ruleset, report.document, report.issues),
		errorCount,
		warningCount,
	};
}

/**
 * `handler` for defineDisplay: the plain-text form used where the app needs
 * a string (display templates, CSV export through
 * app/src/utils/render-string-template.ts:85 and save-as-csv.ts:55).
 */
export function summaryHandler(
	value: unknown,
	_options: Record<string, unknown> | null | undefined,
	context: { interfaceOptions?: Record<string, unknown> | undefined } = {},
): string | null {
	return displaySummary(value, context.interfaceOptions)?.text ?? null;
}
