/**
 * Interface options of the node-graph field: the plain options as Directus
 * field definitions, and the resolver that turns the stored options
 * (directus_fields.meta.options) into values with defaults applied.
 *
 * The options are edited by a custom options component
 * (options-editor/NodeGraphOptions.vue, `defineInterface({ options })` in
 * src/interface.ts). It renders `generalOptionFields` with the app's v-form,
 * exactly as Directus would render an options array, and edits the `ruleset`
 * option with its own form of stock interfaces. The stored shape is the same
 * either way: one object with the keys of NodeGraphFieldOptions.
 *
 * Option defaults (`schema.default_value`) only pre-fill the form; an option
 * the admin never touched is simply absent from the stored options, so the
 * interface, the display and the hook must all read options through
 * `resolveFieldOptions()` rather than trusting the defaults here to have
 * been saved.
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
 * The example ruleset as pretty JSON with tabs: the text of
 * examples/approval-workflow.json (tests/options.test.ts compares them) and
 * the format the options form's JSON editor shows and exports. The form
 * stores the ruleset as an object; one written through the API may be a JSON
 * string, which compileRuleset and the form also accept.
 */
export const RULESET_TEMPLATE = JSON.stringify(exampleRuleset, null, '\t');

const TEMPLATE_TOKENS =
	'`{{nodeCount}}`, `{{edgeCount}}`, `{{errorCount}}`, `{{warningCount}}`, `{{counts.<type key>}}`, `{{ruleset.name}}`, `{{ruleset.version}}`';

/**
 * Every option except `ruleset`, as the Directus field definitions of an
 * options array. The options component shows them in a v-form above the
 * ruleset, the way extension-options.vue would show an options array
 * (directus-11.17.4/app/src/modules/settings/routes/data-model/field-detail/shared/extension-options.vue:80-89).
 *
 * Typed as `DeepPartial<AppField>` (not `Field`): `Field.schema` may be null
 * where `AppField.schema` may not, so a `Field`-typed array fails vue-tsc.
 */
export const generalOptionFields: DeepPartial<AppField>[] = [
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
				label: 'Show a minimap',
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
