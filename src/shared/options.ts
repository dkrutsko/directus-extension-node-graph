/**
 * Interface options of the node-graph field, for `defineInterface({ options })`
 * in src/interface.ts, plus the resolver that turns the stored options
 * (directus_fields.meta.options) into values with defaults applied.
 *
 * Option defaults (`schema.default_value`) only pre-fill the field setup form
 * in Data Model; an option the admin never touched is simply absent from the
 * stored options, so the interface, the display and the hook must all read
 * options through `resolveFieldOptions()` rather than trusting the defaults
 * here to have been saved.
 */

import type { AppField, DeepPartial } from '@directus/types';
import { exampleRuleset } from './core/example-ruleset';
import { DEFAULT_FIELD_TEMPLATE } from './core/summary';
import type { EnforcementPolicy, NodeGraphFieldOptions, Ruleset } from './core/types';
import { isPlainObject } from './core/util';

export type EditorWidth = 'standard' | 'wide' | 'full';

/** Options with every default applied. `ruleset` stays raw: compile it with `compileRuleset()`. */
export interface ResolvedFieldOptions {
	ruleset: Ruleset | string | null;
	template: string | null;
	placeholder: string | null;
	editorWidth: EditorWidth;
	enforcement: EnforcementPolicy;
	snapToGrid: boolean;
	gridSize: number;
	showMinimap: boolean;
}

export const DEFAULT_EDITOR_WIDTH: EditorWidth = 'wide';
export const DEFAULT_ENFORCEMENT: EnforcementPolicy = 'ratchet';

/** The Flows / Insights workspace grid (directus-11.17.4/app/src/modules/settings/routes/flows/constants.ts:5, v-workspace.vue:24). */
export const DEFAULT_GRID_SIZE = 18;
export const MIN_GRID_SIZE = 4;
export const MAX_GRID_SIZE = 96;

const EDITOR_WIDTHS = new Set<string>(['standard', 'wide', 'full']);
const ENFORCEMENT_POLICIES = new Set<string>(['ratchet', 'reject', 'log', 'off']);

/**
 * The example ruleset as the input-code interface's `template`. For a field of
 * type `json` the stock interface shows a "Fill template" button and, when
 * clicked, emits `JSON.parse(template)` (the parsed object, not the string;
 * directus-11.17.4/app/src/interfaces/input-code/input-code.vue:282-292, and
 * the button at :303-313). Edits in JSON mode are stored as parsed objects
 * too (:77-92), so a ruleset saved through Data Model arrives as an object;
 * one written through the API may still be a string, which compileRuleset
 * also accepts.
 */
export const RULESET_TEMPLATE = JSON.stringify(exampleRuleset, null, '\t');

const TEMPLATE_TOKENS =
	'`{{nodeCount}}`, `{{edgeCount}}`, `{{errorCount}}`, `{{warningCount}}`, `{{counts.<type key>}}`, `{{ruleset.name}}`, `{{ruleset.version}}`';

/**
 * Typed as `DeepPartial<AppField>` (not `Field`): that is what
 * defineInterface's `options` expects (@directus/types InterfaceConfig), and
 * `Field.schema` may be null where `AppField.schema` may not, so a
 * `Field`-typed array fails vue-tsc.
 */
export const nodeGraphOptions: DeepPartial<AppField>[] = [
	{
		field: 'ruleset',
		name: 'Ruleset',
		type: 'json',
		meta: {
			width: 'full',
			// In JSON mode because the option's type is json (input-code.vue:128);
			// the `language` option does not apply to json fields.
			interface: 'input-code',
			options: {
				lineNumber: true,
				template: RULESET_TEMPLATE,
			},
			note: 'Node types, ports, fields, connection and graph rules, as JSON. Use the button in the editor to start from the example "Approval workflow" ruleset. The ruleset is checked when the field is saved.',
		},
	},
	{
		field: 'template',
		name: 'Summary Template',
		type: 'string',
		meta: {
			width: 'full',
			interface: 'input',
			options: {
				placeholder: DEFAULT_FIELD_TEMPLATE,
				font: 'monospace',
			},
			note: `Text shown in the field and in the table display. Tokens: ${TEMPLATE_TOKENS}. Plain text only.`,
		},
	},
	{
		field: 'placeholder',
		name: '$t:placeholder',
		type: 'string',
		meta: {
			width: 'half',
			interface: 'input',
			options: {
				placeholder: '$t:enter_a_placeholder',
			},
			note: 'Shown while the field has no graph.',
		},
	},
	{
		field: 'editorWidth',
		name: 'Editor Width',
		type: 'string',
		meta: {
			width: 'half',
			interface: 'select-dropdown',
			options: {
				choices: [
					{ text: 'Standard (like other drawers)', value: 'standard' },
					{ text: 'Wide', value: 'wide' },
					{ text: 'Full', value: 'full' },
				],
			},
		},
		schema: {
			default_value: DEFAULT_EDITOR_WIDTH,
		},
	},
	{
		field: 'enforcement',
		name: 'Server Enforcement',
		type: 'string',
		meta: {
			width: 'full',
			interface: 'select-dropdown',
			options: {
				choices: [
					{ text: 'Ratchet', value: 'ratchet' },
					{ text: 'Reject', value: 'reject' },
					{ text: 'Log only', value: 'log' },
					{ text: 'Off', value: 'off' },
				],
			},
			note: 'How the server treats graphs with errors when an item is saved, whichever way it is written (app, API, import, flows with "Emit Events"). **Ratchet**: reject a save only if it adds errors the stored graph did not already have; new items and empty fields must have no errors. **Reject**: reject any save with errors. **Log only**: accept and log the error counts. **Off**: no server checks. Warnings never block a save.',
		},
		schema: {
			default_value: DEFAULT_ENFORCEMENT,
		},
	},
	{
		field: 'snapToGrid',
		name: 'Snap to Grid',
		type: 'boolean',
		meta: {
			width: 'half',
			interface: 'boolean',
			options: {
				label: 'Snap nodes to the grid',
			},
		},
		schema: {
			default_value: true,
		},
	},
	{
		field: 'gridSize',
		name: 'Grid Size',
		type: 'integer',
		meta: {
			width: 'half',
			interface: 'input',
			options: {
				min: MIN_GRID_SIZE,
				max: MAX_GRID_SIZE,
				step: 1,
			},
			note: 'In canvas units at 100% zoom.',
		},
		schema: {
			default_value: DEFAULT_GRID_SIZE,
		},
	},
	{
		field: 'showMinimap',
		name: 'Minimap',
		type: 'boolean',
		meta: {
			width: 'half',
			interface: 'boolean',
			options: {
				label: 'Show a minimap where the library has one',
			},
		},
		schema: {
			default_value: false,
		},
	},
];

/**
 * Stored options (any shape, possibly partial, possibly a Vue props object)
 * to resolved options with defaults. Never throws; unknown or malformed
 * values fall back to the default.
 */
export function resolveFieldOptions(raw: unknown): ResolvedFieldOptions {
	const options = (isPlainObject(raw) ? raw : {}) as NodeGraphFieldOptions & Record<string, unknown>;

	const gridSize =
		typeof options.gridSize === 'number' && Number.isFinite(options.gridSize)
			? Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, Math.round(options.gridSize)))
			: DEFAULT_GRID_SIZE;

	return {
		ruleset: isPlainObject(options.ruleset) || typeof options.ruleset === 'string' ? (options.ruleset as Ruleset | string) : null,
		template: typeof options.template === 'string' && options.template.trim() !== '' ? options.template : null,
		placeholder: typeof options.placeholder === 'string' && options.placeholder !== '' ? options.placeholder : null,
		editorWidth: EDITOR_WIDTHS.has(options.editorWidth as string) ? (options.editorWidth as EditorWidth) : DEFAULT_EDITOR_WIDTH,
		enforcement: ENFORCEMENT_POLICIES.has(options.enforcement as string)
			? (options.enforcement as EnforcementPolicy)
			: DEFAULT_ENFORCEMENT,
		snapToGrid: typeof options.snapToGrid === 'boolean' ? options.snapToGrid : true,
		gridSize,
		showMinimap: options.showMinimap === true,
	};
}
