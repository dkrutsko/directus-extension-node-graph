/**
 * The fields of the ruleset form: what the options component hands the
 * app's global `v-form`, in the Directus field shape.
 *
 * Everything is a stock interface by its registered id
 * (directus-11.17.4/app/src/interfaces/<id>/index.ts), so the form looks and
 * behaves like the stock options:
 *
 * - sections are `group-detail` alias groups (interfaces/group-detail);
 * - lists are Repeaters (`list`), configured like the stock Repeater's own
 *   "Edit Fields" (interfaces/list/options.vue:42-208); a node type's fields
 *   use the very same pickers: `system-interface` with `typeField`,
 *   `system-interface-options` with `interfaceField`, `system-display` and
 *   `system-display-options`, which read the sibling values through
 *   `inject('values')` (interfaces/_system/system-interface/system-interface.vue:19-27,
 *   system-interface-options.vue:32-34);
 * - explanations are `presentation-notice` fields and field notes.
 *
 * Names and choice texts may be `$t:` keys: v-form translates every string
 * of a field deeply before rendering it, nested Repeater fields included
 * (components/v-form/utils/get-form-fields.ts:22, utils/translate-object-values.ts).
 * Names of Repeater sub-fields then go through formatTitle (list.vue:94-101),
 * so they are plain words without punctuation.
 *
 * Choices that point at other parts of the ruleset (data types, node types,
 * edge types, field keys, starter refs) are computed from the current form
 * model by `collectChoices()`. A value that is referenced but not defined
 * (a renamed key, say) stays in the choices as "(not defined)": the stock
 * select-dropdown clears a value that disappears from its choices
 * (select-dropdown.vue:66-78), which would silently change the ruleset.
 *
 * Framework-free, like view-model.ts.
 */

import { DEFAULT_SEVERITIES, ISSUE_CODES } from '../core/compile';
import { isPlainObject } from '../core/util';
import { DEFAULTS, DYNAMIC_PORT_NAMES, type RulesetViewModel, type ViewItem } from './view-model';

/** A field definition as v-form takes it (`Field` from @directus/types, loosely). */
export interface FormFieldDefinition {
	field: string;
	name?: string;
	type: string;
	meta: Record<string, unknown>;
	schema?: { default_value: unknown };
}

export interface Choice {
	text: string;
	value: string;
}

/* ------------------------------------------------------------------------ */
/* Builders                                                                 */
/* ------------------------------------------------------------------------ */

type Width = 'half' | 'half-left' | 'half-right' | 'full' | 'fill';

interface FieldSettings {
	width?: Width | undefined;
	note?: string | undefined;
	options?: Record<string, unknown> | undefined;
	/** schema.default_value: what the form shows while the key is absent. */
	fallback?: unknown;
	group?: string | undefined;
	/** The display a Repeater's row template uses for this field. */
	display?: string | undefined;
	/** Stock field conditions (`meta.conditions`). */
	conditions?: Record<string, unknown>[] | undefined;
}

function input(field: string, name: string, type: string, interfaceId: string, settings: FieldSettings = {}): FormFieldDefinition {
	const definition: FormFieldDefinition = {
		field,
		name,
		type,
		meta: {
			field,
			interface: interfaceId,
			width: settings.width ?? 'full',
			options: settings.options ?? null,
			note: settings.note ?? null,
			group: settings.group ?? null,
		},
	};

	if (settings.display) definition.meta['display'] = settings.display;
	if (settings.conditions && settings.conditions.length > 0) definition.meta['conditions'] = settings.conditions;
	if (settings.fallback !== undefined) definition.schema = { default_value: settings.fallback };

	return definition;
}

/** A collapsible `group-detail` section; its fields name it in `group`. */
function section(field: string, name: string, start: 'open' | 'closed', settings: { icon?: string | undefined; group?: string | undefined } = {}): FormFieldDefinition {
	const options: Record<string, unknown> = { start };
	if (settings.icon) options['headerIcon'] = settings.icon;

	return {
		field,
		name,
		type: 'alias',
		meta: {
			field,
			interface: 'group-detail',
			special: ['alias', 'no-data', 'group'],
			width: 'full',
			options,
			group: settings.group ?? null,
		},
	};
}

/** Explanatory text, the stock `presentation-notice` (markdown). */
function notice(field: string, text: string, group?: string): FormFieldDefinition {
	return {
		field,
		type: 'alias',
		meta: {
			field,
			interface: 'presentation-notice',
			special: ['alias', 'no-data'],
			width: 'full',
			options: { text, color: 'normal', icon: 'info' },
			group: group ?? null,
		},
	};
}

/** A Repeater (`list`) over `fields`, configured as the stock one is. */
function repeater(
	field: string,
	name: string,
	fields: FormFieldDefinition[],
	settings: { template: string; addLabel: string; placeholder: string; headerPlaceholder: string; note?: string | undefined; group?: string | undefined },
): FormFieldDefinition {
	return input(field, name, 'json', 'list', {
		note: settings.note,
		group: settings.group,
		options: {
			fields: sorted(fields),
			template: settings.template,
			addLabel: settings.addLabel,
			placeholder: settings.placeholder,
			headerPlaceholder: settings.headerPlaceholder,
		},
	});
}

/** v-form orders fields by group, then `meta.sort` (get-form-fields.ts:16): number them in the order given. */
function sorted(fields: FormFieldDefinition[]): FormFieldDefinition[] {
	return fields.map((definition, index) => ({ ...definition, meta: { ...definition.meta, sort: index + 1 } }));
}

const MONO = { font: 'monospace' } as const;

/*
 * Keys in monospace, without the input's `trim` option: a trimming input
 * emits its value again on every blur, changed or not (v-input.vue:206-216
 * `trimIfEnabled`), which in a Repeater drawer counts as an edit (list.vue
 * `checkDiscard` then asks about unsaved changes after merely clicking into
 * the field). A key with spaces is reported by the compiler instead.
 */
const KEY_INPUT = MONO;

/* ------------------------------------------------------------------------ */
/* Choices                                                                  */
/* ------------------------------------------------------------------------ */

export interface ChoiceSets {
	/** `any` first, then the declared data types. */
	dataTypes: Choice[];
	nodeTypes: Choice[];
	/** `*` first, then the node types: pair rule members. */
	nodeTypesOrAny: Choice[];
	edgeTypes: Choice[];
	issueCodes: Choice[];
	/** Every field key of every node type: suggestions for summary fields. */
	fieldKeys: string[];
	/** Field keys of type json: candidates for dynamic outputs. */
	jsonFieldKeys: Choice[];
	starterRefs: Choice[];
	/** The field keys of each node type, for the summary suggestions of that type's drawer (see `perTypeConditions`). */
	nodeTypeFields: Array<{ key: string; fieldKeys: string[] }>;
}

const ISSUE_CODE_SET = new Set<string>(ISSUE_CODES);

function rows(value: unknown): ViewItem[] {
	return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

function texts(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter(nonEmpty);
	return nonEmpty(value) ? [value] : [];
}

/**
 * Choices of the declared keys (`Label (key)`), followed by the referenced
 * keys that are not declared.
 */
function keyChoices(items: ViewItem[], referenced: Iterable<string>, leading: Choice[] = []): Choice[] {
	const choices: Choice[] = [...leading];
	const seen = new Set(leading.map((choice) => choice.value));

	for (const item of items) {
		const key = item['key'];
		if (!nonEmpty(key) || seen.has(key)) continue;

		seen.add(key);
		const label = item['label'];
		choices.push({ text: nonEmpty(label) && label !== key ? `${label} (${key})` : key, value: key });
	}

	for (const value of referenced) {
		if (seen.has(value)) continue;
		seen.add(value);
		choices.push({ text: `${value} (not defined)`, value });
	}

	return choices;
}

export function collectChoices(vm: RulesetViewModel): ChoiceSets {
	const dataTypes = rows(vm.dataTypes);
	const nodeTypes = rows(vm.nodeTypes);
	const edgeTypes = rows(vm.edgeTypes);

	const usedDataTypes: string[] = [];
	const usedEdgeTypes: string[] = texts(vm.defaultEdgeType);
	const usedNodeTypes: string[] = texts(vm.entryNodeTypes);
	const usedJsonFields: string[] = [];
	const fieldKeys = new Set<string>();
	const jsonFieldKeys = new Set<string>();
	const nodeTypeFields: ChoiceSets['nodeTypeFields'] = [];

	for (const dataType of dataTypes) usedDataTypes.push(...texts(dataType['accepts']));

	for (const nodeType of nodeTypes) {
		for (const port of [...rows(nodeType['inputs']), ...rows(nodeType['outputs'])]) {
			usedDataTypes.push(...texts(port['dataType']));
			usedEdgeTypes.push(...texts(port['edgeTypes']), ...texts(port['newEdgeType']));
		}

		usedDataTypes.push(...texts(nodeType[DYNAMIC_PORT_NAMES.dataType]));
		usedEdgeTypes.push(...texts(nodeType[DYNAMIC_PORT_NAMES.edgeTypes]), ...texts(nodeType[DYNAMIC_PORT_NAMES.newEdgeType]));
		usedJsonFields.push(...texts(nodeType['dynamicField']));

		const ownKeys: string[] = [];

		for (const field of rows(nodeType['fields'])) {
			if (!nonEmpty(field['field'])) continue;
			fieldKeys.add(field['field']);
			ownKeys.push(field['field']);
			if (field['type'] === 'json') jsonFieldKeys.add(field['field']);
		}

		for (const key of texts(nodeType['summaryFields'])) fieldKeys.add(key);

		if (nonEmpty(nodeType['key'])) nodeTypeFields.push({ key: nodeType['key'], fieldKeys: ownKeys });
	}

	for (const rule of rows(vm.pairRules)) {
		usedNodeTypes.push(...texts(rule['source']).filter((value) => value !== '*'), ...texts(rule['target']).filter((value) => value !== '*'));
	}

	const starterNodes = rows(vm.starterNodes);
	const refs: string[] = [];

	for (const node of starterNodes) {
		usedNodeTypes.push(...texts(node['type']));
		refs.push(...texts(node['ref']));
	}

	const usedRefs: string[] = [];

	for (const edge of rows(vm.starterEdges)) {
		usedEdgeTypes.push(...texts(edge['type']));
		usedRefs.push(...texts(edge['source']), ...texts(edge['target']));
	}

	const usedCodes = rows(vm.severity)
		.map((entry) => entry['code'])
		.filter((code): code is string => nonEmpty(code) && !ISSUE_CODE_SET.has(code));

	const nodeTypeChoices = keyChoices(nodeTypes, usedNodeTypes);

	return {
		dataTypes: keyChoices(dataTypes, usedDataTypes.filter((value) => value !== 'any'), [{ text: 'Any', value: 'any' }]),
		nodeTypes: nodeTypeChoices,
		nodeTypesOrAny: [{ text: 'Any node type (*)', value: '*' }, ...nodeTypeChoices],
		edgeTypes: keyChoices(edgeTypes, usedEdgeTypes),
		issueCodes: [
			...ISSUE_CODES.map((code) => ({ text: `${code} (default: ${DEFAULT_SEVERITIES[code]})`, value: code })),
			...[...new Set(usedCodes)].map((code) => ({ text: `${code} (not an issue code)`, value: code })),
		],
		fieldKeys: [...fieldKeys],
		jsonFieldKeys: [...jsonFieldKeys, ...usedJsonFields.filter((key) => !jsonFieldKeys.has(key))]
			.filter((key, index, all) => all.indexOf(key) === index)
			.map((key) => ({ text: jsonFieldKeys.has(key) ? key : `${key} (not a json field)`, value: key })),
		starterRefs: [...new Set([...refs, ...usedRefs])].map((ref) => ({ text: refs.includes(ref) ? ref : `${ref} (not a starter node)`, value: ref })),
		nodeTypeFields,
	};
}

/**
 * Stock field conditions (`meta.conditions`, evaluated by v-form against the
 * values of the drawer it renders, utils/apply-conditions.ts) that narrow a
 * node type's summary suggestions to its own fields: one condition per node
 * type, matching on the key the drawer shows. A drawer whose key matches none
 * (a new type, a key being renamed) falls back to the suggestions of every
 * type. Conditions replace arrays in `options` (apply-conditions.ts:42-48).
 */
function perTypeConditions(choices: ChoiceSets, options: (type: ChoiceSets['nodeTypeFields'][number]) => Record<string, unknown>): Record<string, unknown>[] {
	return choices.nodeTypeFields.map((type) => ({
		name: `Node type ${type.key}`,
		rule: { key: { _eq: type.key } },
		options: options(type),
	}));
}

/* ------------------------------------------------------------------------ */
/* Static choices                                                           */
/* ------------------------------------------------------------------------ */

/** The field types a node or edge field may have (compile.ts FIELD_TYPES), in the order of the stock type select (app/src/constants.ts FIELD_TYPES_SELECT). */
const FIELD_TYPE_CHOICES: Choice[] = [
	{ text: '$t:string', value: 'string' },
	{ text: '$t:text', value: 'text' },
	{ text: '$t:boolean', value: 'boolean' },
	{ text: '$t:integer', value: 'integer' },
	{ text: '$t:bigInteger', value: 'bigInteger' },
	{ text: '$t:float', value: 'float' },
	{ text: '$t:decimal', value: 'decimal' },
	{ text: '$t:timestamp', value: 'timestamp' },
	{ text: '$t:datetime', value: 'dateTime' },
	{ text: '$t:date', value: 'date' },
	{ text: '$t:time', value: 'time' },
	{ text: '$t:json', value: 'json' },
	{ text: '$t:csv', value: 'csv' },
	{ text: '$t:uuid', value: 'uuid' },
	{ text: '$t:hash', value: 'hash' },
	{ text: '$t:alias', value: 'alias' },
];

const WIDTH_CHOICES: Choice[] = [
	{ text: '$t:half_width', value: 'half' },
	{ text: 'Half Width, Left', value: 'half-left' },
	{ text: 'Half Width, Right', value: 'half-right' },
	{ text: '$t:full_width', value: 'full' },
	{ text: '$t:fill_width', value: 'fill' },
];

const SIDE_CHOICES: Choice[] = [
	{ text: 'Left', value: 'left' },
	{ text: 'Right', value: 'right' },
	{ text: 'Top', value: 'top' },
	{ text: 'Bottom', value: 'bottom' },
];

const SEVERITY_CHOICES: Choice[] = [
	{ text: 'Error', value: 'error' },
	{ text: 'Warning', value: 'warning' },
	{ text: 'Off', value: 'off' },
];

/* ------------------------------------------------------------------------ */
/* Notes                                                                    */
/* ------------------------------------------------------------------------ */

const KEY_RULE = '1 to 64 letters, digits, `_` and `-`, not starting with `-`.';
const COLOR_NOTE = 'A hex colour, or a theme variable such as `var(--theme--primary)`, `var(--theme--secondary)` or `var(--theme--warning)`, which follows light and dark mode.';

const DEFAULT_VALUE_NOTE =
	'Filled in when a node or connection is created. Typed as text and stored by the field type: `true` or `false` for boolean, a number for integer and float, JSON for json (`{"a": 1}`, `["a"]`), a JSON list or comma-separated values for csv, and the text as it is for every other type. Empty means no default.';

/* ------------------------------------------------------------------------ */
/* Sub-forms                                                                */
/* ------------------------------------------------------------------------ */

/** A node or edge field, the stock Repeater's "Edit Fields" plus name, readonly, hidden and the default value. */
function fieldDefinitionFields(): FormFieldDefinition[] {
	return [
		input('field', '$t:key', 'string', 'input', {
			width: 'half',
			options: { ...KEY_INPUT, placeholder: '$t:field_name_placeholder' },
			note: `Stored as the key in the element's data. ${KEY_RULE}`,
			display: 'raw',
		}),
		input('name', '$t:name', 'string', 'input', { width: 'half', options: { placeholder: 'Default: the key in title case' } }),
		input('type', '$t:type', 'string', 'select-dropdown', {
			width: 'half',
			options: { choices: FIELD_TYPE_CHOICES },
			note: 'Alias for fields that hold no data, such as a notice.',
		}),
		input('width', '$t:field_width', 'string', 'select-dropdown', { width: 'half', options: { choices: WIDTH_CHOICES }, fallback: DEFAULTS.width }),
		input('required', '$t:required', 'boolean', 'boolean', {
			width: 'half',
			options: { label: '$t:requires_value' },
			fallback: DEFAULTS.required,
			note: 'An empty value is an error.',
		}),
		input('readonly', '$t:readonly', 'boolean', 'boolean', { width: 'half', options: { label: 'Disable the field in the inspector' }, fallback: DEFAULTS.readonly }),
		input('hidden', '$t:hidden', 'boolean', 'boolean', {
			width: 'half',
			options: { label: 'Hide the field in the inspector' },
			fallback: DEFAULTS.hidden,
			note: 'Hidden fields are never reported as missing.',
		}),
		input('defaultValue', '$t:default_value', 'string', 'input', { width: 'full', options: { ...MONO, placeholder: 'No default' }, note: DEFAULT_VALUE_NOTE }),
		input('note', '$t:note', 'string', 'input', { width: 'full', options: { placeholder: '$t:interfaces.list.field_note_placeholder' } }),
		section('group-interface', '$t:interfaces.list.interface_group', 'open'),
		input('interface', '$t:interface_label', 'string', 'system-interface', {
			width: 'half',
			group: 'group-interface',
			options: { typeField: 'type' },
			note: 'Interfaces that need a relation or a collection (file, files, M2O, O2M, M2M, M2A, translations and the groups) cannot be used inside a node.',
			display: 'raw',
		}),
		input('options', '$t:interface_options', 'string', 'system-interface-options', { width: 'full', group: 'group-interface', options: { interfaceField: 'interface' } }),
		section('group-display', '$t:interfaces.list.display_group', 'closed'),
		input('display', '$t:display_label', 'string', 'system-display', {
			width: 'half',
			group: 'group-display',
			options: { typeField: 'type' },
			note: 'Passed to the form as it is; the card and the issues show the value formatted by the interface choices.',
		}),
		input('display_options', '$t:display_options', 'string', 'system-display-options', { width: 'full', group: 'group-display', options: { displayField: 'display' } }),
	];
}

function fieldsRepeater(field: string, owner: 'node' | 'connection', group?: string): FormFieldDefinition {
	return repeater(field, 'Fields', fieldDefinitionFields(), {
		template: '{{ field }} — {{ interface }}',
		addLabel: 'Add Field',
		placeholder: 'No fields',
		headerPlaceholder: 'New Field',
		group,
		note: `Edited in the inspector when a ${owner} is selected, and stored in its data.`,
	});
}

/** The settings every port has, under `names` (a port's own names, or the `dynamic…` ones). */
function portSettingFields(choices: ChoiceSets, names: typeof DYNAMIC_PORT_NAMES, output: boolean, group?: string): FormFieldDefinition[] {
	const fields = [
		input(names.dataType, 'Data Type', 'string', 'select-dropdown', {
			width: 'half',
			group,
			options: { choices: choices.dataTypes },
			fallback: DEFAULTS.dataType,
			note: 'Which connections fit (see Data Types). Any connects to everything.',
		}),
		input(names.side, 'Side', 'string', 'select-dropdown', {
			width: 'half',
			group,
			options: { choices: SIDE_CHOICES, allowNone: true, placeholder: 'Default' },
			note: 'Default: inputs left and outputs right, or top and bottom when the direction is top to bottom. Top and bottom ports show their label as a tooltip.',
		}),
		input(names.minConnections, 'Min Connections', 'integer', 'input', {
			width: 'half',
			group,
			options: { min: 0 },
			fallback: DEFAULTS.minConnections,
			note: 'Fewer connections are a warning.',
		}),
		input(names.maxConnections, 'Max Connections', 'integer', 'input', {
			width: 'half',
			group,
			options: { min: 1, placeholder: '$t:unlimited' },
			note: 'More connections are an error, and the editor refuses them.',
		}),
	];

	if (output) {
		fields.push(
			input(names.edgeTypes, 'Edge Types', 'json', 'select-multiple-dropdown', {
				width: 'half',
				group,
				options: { choices: choices.edgeTypes, placeholder: 'Every edge type' },
				note: 'The connection types that may start here. Empty allows every type.',
			}),
			input(names.newEdgeType, 'New Connections', 'string', 'select-dropdown', {
				width: 'half',
				group,
				options: { choices: choices.edgeTypes, allowNone: true, placeholder: 'First allowed type' },
				note: 'The type a new connection from here gets; one of the allowed types. Stored by putting it first in the list.',
			}),
		);
	}

	return fields;
}

function portRepeater(field: 'inputs' | 'outputs', choices: ChoiceSets, group: string): FormFieldDefinition {
	const output = field === 'outputs';

	return repeater(field, output ? 'Outputs' : 'Inputs', [
		input('key', '$t:key', 'string', 'input', {
			width: 'half',
			options: { ...KEY_INPUT, placeholder: output ? 'next' : 'in' },
			note: `Stored in each connection's ${output ? 'sourceHandle' : 'targetHandle'}. Unique among this type's ${field}. ${KEY_RULE}`,
			display: 'raw',
		}),
		input('label', '$t:label', 'string', 'input', { width: 'half', options: { placeholder: 'Default: the key' }, display: 'raw' }),
		...portSettingFields(choices, { dataType: 'dataType', side: 'side', minConnections: 'minConnections', maxConnections: 'maxConnections', edgeTypes: 'edgeTypes', newEdgeType: 'newEdgeType' }, output),
	], {
		template: '{{label}} ({{key}})',
		addLabel: output ? 'Add Output' : 'Add Input',
		placeholder: output ? 'No outputs' : 'No inputs',
		headerPlaceholder: output ? 'New Output' : 'New Input',
		group,
		note: output ? 'Connections start at outputs.' : 'Connections end at inputs.',
	});
}

function nodeTypeFields(choices: ChoiceSets): FormFieldDefinition[] {
	const dynamic = 'group-dynamic';

	return [
		input('key', '$t:key', 'string', 'input', {
			width: 'half',
			options: { ...KEY_INPUT, placeholder: 'task' },
			note: `Stored in each node's type. ${KEY_RULE} Renaming it does not change stored graphs.`,
			display: 'raw',
		}),
		input('label', '$t:label', 'string', 'input', { width: 'half', options: { placeholder: 'Default: the key in title case' }, note: 'The palette entry and the card headline.', display: 'raw' }),
		input('icon', '$t:icon', 'string', 'select-icon', { width: 'half', note: 'Default: `category` for a type with a category, else `account_tree`.' }),
		input('color', '$t:color', 'string', 'select-color', { width: 'half', note: `Tints the card's icon tile and the palette icon. Default: the primary colour. ${COLOR_NOTE}` }),
		input('category', 'Category', 'string', 'input', { width: 'half', options: { placeholder: 'Steps' }, note: 'Palette group. Types without a category come first.' }),
		input('description', '$t:description', 'text', 'input-multiline', { width: 'full', note: 'The tooltip of the palette entry.' }),

		section('group-behaviour', 'Behaviour', 'open'),
		input('deprecated', 'Deprecated', 'boolean', 'boolean', {
			width: 'half',
			group: 'group-behaviour',
			options: { label: 'Hide from the palette' },
			fallback: DEFAULTS.deprecated,
			note: 'Existing nodes keep working, with a warning.',
		}),
		input('deletable', 'Deletable', 'boolean', 'boolean', {
			width: 'half',
			group: 'group-behaviour',
			options: { label: 'Nodes can be deleted in the editor' },
			fallback: DEFAULTS.deletable,
			note: 'The server does not enforce this; use Min Instances when a node must exist.',
		}),
		input('minInstances', 'Min Instances', 'integer', 'input', {
			width: 'half',
			group: 'group-behaviour',
			options: { min: 0 },
			note: 'Fewer nodes of this type are a warning. Also what Create seeds when there is no starter graph.',
		}),
		input('maxInstances', 'Max Instances', 'integer', 'input', {
			width: 'half',
			group: 'group-behaviour',
			options: { min: 0, placeholder: '$t:unlimited' },
			note: 'More nodes are an error, and the palette disables the type at the limit.',
		}),

		section('group-card', 'Card', 'open'),
		input('titleTemplate', 'Title Template', 'string', 'input', {
			width: 'full',
			group: 'group-card',
			options: { ...MONO, placeholder: '{{title}}' },
			note: 'The card title. Tokens: the field keys of this type, such as `{{title}}` or `{{customer.name}}`, and `{{$type}}` for the type label. Select fields show their choice text. When every token is empty the title is the label.',
		}),
		input('summaryFields', 'Summary Fields', 'json', 'tags', {
			width: 'full',
			group: 'group-card',
			options: { presets: choices.fieldKeys, placeholder: 'Add a field key…', iconRight: 'short_text' },
			conditions: perTypeConditions(choices, (type) => ({ presets: type.fieldKeys })),
			note: 'Field keys shown on the card under the title, one row each, in the order they were added. Each must be a field of this type. Click a suggestion to add or remove it.',
		}),

		section('group-fields', 'Fields', 'open'),
		fieldsRepeater('fields', 'node', 'group-fields'),

		section('group-ports', 'Ports', 'open'),
		portRepeater('inputs', choices, 'group-ports'),
		portRepeater('outputs', choices, 'group-ports'),

		section(dynamic, 'Dynamic Outputs', 'closed'),
		notice(
			'notice-dynamic',
			'Generates one output per item of a list field, normally a Repeater. The outputs are keyed `<field>.0`, `<field>.1`, … by position, so reordering the items moves their connections. Pair rules match all of them with `<field>.*`.',
			dynamic,
		),
		input('dynamicField', 'Source Field', 'string', 'select-dropdown', {
			width: 'half',
			group: dynamic,
			// Every type's json fields, not narrowed per type like the summary suggestions: a select
			// clears its value when its choices change without it (select-dropdown.vue:66-78), which a
			// condition matching another type's key would do.
			options: { choices: choices.jsonFieldKeys, allowNone: true, allowOther: true, placeholder: 'No dynamic outputs' },
			note: 'A json field of this type.',
		}),
		input('dynamicPlacement', 'Placement', 'string', 'select-dropdown', {
			width: 'half',
			group: dynamic,
			options: {
				choices: [
					{ text: 'After the static outputs', value: 'end' },
					{ text: 'Before the static outputs', value: 'start' },
				],
			},
			fallback: DEFAULTS.placement,
		}),
		input('dynamicLabelTemplate', 'Label Template', 'string', 'input', {
			width: 'full',
			group: dynamic,
			options: { ...MONO, placeholder: '{{label}}' },
			note: 'Rendered against one item of the list, for example `{{label}}`. Without it a text or number item is its own label. Empty labels show as #1, #2, …',
		}),
		...portSettingFields(choices, DYNAMIC_PORT_NAMES, true, dynamic),
	];
}

function edgeTypeFields(): FormFieldDefinition[] {
	return [
		input('key', '$t:key', 'string', 'input', {
			width: 'half',
			options: { ...KEY_INPUT, placeholder: 'flow' },
			note: `Stored in each connection's type. ${KEY_RULE}`,
			display: 'raw',
		}),
		input('label', '$t:label', 'string', 'input', { width: 'half', options: { placeholder: 'Default: the key in title case' }, display: 'raw' }),
		input('path', 'Path', 'string', 'select-dropdown', {
			width: 'half',
			options: {
				choices: [
					{ text: 'Curve', value: 'bezier' },
					{ text: 'Step', value: 'step' },
					{ text: 'Straight', value: 'straight' },
				],
			},
			fallback: DEFAULTS.path,
			note: 'Step draws right angles with rounded corners, like Flows.',
		}),
		input('marker', 'Marker', 'string', 'select-dropdown', {
			width: 'half',
			options: {
				choices: [
					{ text: 'Arrow', value: 'arrow' },
					{ text: 'None', value: 'none' },
				],
			},
			fallback: DEFAULTS.marker,
		}),
		input('color', '$t:color', 'string', 'select-color', { width: 'half', note: `Default: the colour of the source port's data type. ${COLOR_NOTE}` }),
		input('dashed', 'Dashed', 'boolean', 'boolean', { width: 'half', options: { label: 'Dashed line' }, fallback: DEFAULTS.dashed }),
		input('animated', 'Animated', 'boolean', 'boolean', {
			width: 'half',
			options: { label: 'Animate the dashes' },
			fallback: DEFAULTS.animated,
			note: 'The dashes move toward the target, and stand still for users who prefer reduced motion.',
		}),
		input('labelTemplate', 'Label Template', 'string', 'input', {
			width: 'full',
			options: { ...MONO, placeholder: '{{label}}' },
			note: "The label on the connection. Tokens: the field keys of this type, such as `{{label}}`, and `{{$type}}` for the type label. An empty result shows no label.",
		}),
		section('group-fields', 'Fields', 'open'),
		fieldsRepeater('fields', 'connection', 'group-fields'),
	];
}

/* ------------------------------------------------------------------------ */
/* The ruleset form                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Every field of the ruleset form, in sections. The keys of the top-level
 * fields are the keys of RulesetViewModel.
 */
export function rulesetFormFields(choices: ChoiceSets): FormFieldDefinition[] {
	return sorted([
		section('group-ruleset', 'Ruleset', 'open', { icon: 'badge' }),
		input('key', '$t:key', 'string', 'input', {
			width: 'half',
			group: 'group-ruleset',
			options: { ...KEY_INPUT, placeholder: 'approval-workflow' },
			note: 'Required. Identifies the ruleset and is stamped on every graph saved with it. Up to 200 characters.',
		}),
		input('version', '$t:version', 'integer', 'input', {
			width: 'half',
			group: 'group-ruleset',
			options: { min: 0 },
			fallback: DEFAULTS.version,
			note: 'Bump it when you change the ruleset. Stamped on graphs next to the key and shown in the editor title.',
		}),
		input('name', '$t:name', 'string', 'input', {
			width: 'half',
			group: 'group-ruleset',
			options: { placeholder: 'Default: the key' },
			note: 'Shown in the editor title, for example "Approval workflow · v1".',
		}),
		input('direction', 'Direction', 'string', 'select-dropdown', {
			width: 'half',
			group: 'group-ruleset',
			options: {
				choices: [
					{ text: 'Left to right', value: 'LR' },
					{ text: 'Top to bottom', value: 'TB' },
				],
			},
			fallback: DEFAULTS.direction,
			note: 'Decides which side ports sit on by default.',
		}),

		section('group-data-types', 'Data Types', 'open', { icon: 'adjust' }),
		repeater(
			'dataTypes',
			'Data Types',
			[
				input('key', '$t:key', 'string', 'input', { width: 'half', options: { ...KEY_INPUT, placeholder: 'flow' }, note: `${KEY_RULE} \`any\` is built in.`, display: 'raw' }),
				input('label', '$t:label', 'string', 'input', {
					width: 'half',
					options: { placeholder: 'Default: the key in title case' },
					note: 'Shown in messages and in the inspector.',
					display: 'raw',
				}),
				input('color', '$t:color', 'string', 'select-color', { width: 'half', note: `The ring of ports of this type, and of connections from them. ${COLOR_NOTE}` }),
				input('accepts', 'Accepts', 'json', 'select-multiple-dropdown', {
					width: 'half',
					options: { choices: choices.dataTypes, placeholder: 'Only itself' },
					note: 'Output data types an input of this type also accepts. A type always accepts itself; Any accepts everything.',
				}),
			],
			{
				template: '{{label}} ({{key}})',
				addLabel: 'Add Data Type',
				placeholder: 'No data types: every port accepts anything.',
				headerPlaceholder: 'New Data Type',
				group: 'group-data-types',
				note: 'Data types decide which outputs may connect to which inputs. A port without one has the built-in type Any, which connects to everything.',
			},
		),

		section('group-node-types', 'Node Types', 'open', { icon: 'account_tree' }),
		repeater('nodeTypes', 'Node Types', nodeTypeFields(choices), {
			template: '{{label}} ({{key}})',
			addLabel: 'Add Node Type',
			placeholder: 'No node types yet. A ruleset needs at least one.',
			headerPlaceholder: 'New Node Type',
			group: 'group-node-types',
			note: 'What can be added to a graph: palette entry, card, fields and ports of each kind of node.',
		}),

		section('group-edge-types', 'Edge Types', 'open', { icon: 'trending_flat' }),
		repeater('edgeTypes', 'Edge Types', edgeTypeFields(), {
			template: '{{label}} ({{key}})',
			addLabel: 'Add Edge Type',
			placeholder: 'No edge types: every connection uses the built-in type "default", labelled Connection.',
			headerPlaceholder: 'New Edge Type',
			group: 'group-edge-types',
			note: 'Kinds of connection: how they are drawn and which fields they have.',
		}),

		section('group-connection-rules', 'Connection Rules', 'closed', { icon: 'cable' }),
		input('defaultEdgeType', 'Default Edge Type', 'string', 'select-dropdown', {
			width: 'half',
			group: 'group-connection-rules',
			options: { choices: choices.edgeTypes, allowNone: true, placeholder: 'The first edge type' },
			note: 'The type of stored connections without one, and the first type offered by outputs without their own list.',
		}),
		input('typeCheck', 'Type Check', 'string', 'select-dropdown', {
			width: 'half',
			group: 'group-connection-rules',
			options: {
				choices: [
					{ text: 'Strict', value: 'strict' },
					{ text: 'Off', value: 'off' },
				],
			},
			fallback: DEFAULTS.typeCheck,
			note: 'Strict: an input must accept the data type of the output. Off: data types only colour the ports.',
		}),
		input('allowSelfLoops', 'Self Loops', 'boolean', 'boolean', {
			width: 'half',
			group: 'group-connection-rules',
			options: { label: 'Allow self loops' },
			fallback: DEFAULTS.allowSelfLoops,
			note: 'Otherwise a node connected to itself is an error.',
		}),
		input('allowCycles', 'Cycles', 'boolean', 'boolean', {
			width: 'half',
			group: 'group-connection-rules',
			options: { label: 'Allow cycles' },
			fallback: DEFAULTS.allowCycles,
			note: 'Otherwise every connection on a loop of two or more nodes is an error.',
		}),
		input('allowMultiEdges', 'Duplicate Connections', 'boolean', 'boolean', {
			width: 'half',
			group: 'group-connection-rules',
			options: { label: 'Allow duplicates' },
			fallback: DEFAULTS.allowMultiEdges,
			note: 'Otherwise a second connection between the same output and input is an error.',
		}),
		input('pairMode', 'Pair Rules', 'string', 'select-dropdown', {
			width: 'half',
			group: 'group-connection-rules',
			options: {
				choices: [
					{ text: 'Deny the listed pairs', value: 'deny' },
					{ text: 'Allow only the listed pairs', value: 'allow' },
				],
				allowNone: true,
				placeholder: 'No pair rules',
			},
			note: 'Deny: connections that match a rule are refused, with its message. Allow: only connections that match a rule are allowed.',
		}),
		repeater(
			'pairRules',
			'Rules',
			[
				input('source', 'Source', 'string', 'select-dropdown', {
					width: 'half',
					options: { choices: choices.nodeTypesOrAny, allowNone: true, placeholder: 'Any node type' },
					note: "The output's node type.",
					display: 'raw',
				}),
				input('sourcePort', 'Source Port', 'string', 'input', {
					width: 'half',
					options: { ...KEY_INPUT, placeholder: 'Any output' },
					note: 'An output key, `<field>.*` for every dynamic output of that field, or `*`.',
				}),
				input('target', 'Target', 'string', 'select-dropdown', {
					width: 'half',
					options: { choices: choices.nodeTypesOrAny, allowNone: true, placeholder: 'Any node type' },
					note: "The input's node type.",
					display: 'raw',
				}),
				input('targetPort', 'Target Port', 'string', 'input', { width: 'half', options: { ...KEY_INPUT, placeholder: 'Any input' }, note: 'An input key, or `*`.' }),
				input('message', 'Message', 'string', 'input', {
					width: 'full',
					options: { placeholder: 'Default: "<Source> cannot connect to <Target>."' },
					note: 'Deny mode only: the message for connections this rule refuses.',
				}),
			],
			{
				template: '{{source}} → {{target}}',
				addLabel: 'Add Rule',
				placeholder: 'No rules',
				headerPlaceholder: 'New Rule',
				group: 'group-connection-rules',
				note: 'A rule matches a connection when every member matches; an empty member matches anything.',
			},
		),

		section('group-graph-rules', 'Graph Rules', 'closed', { icon: 'rule' }),
		input('minNodes', 'Min Nodes', 'integer', 'input', { width: 'half', group: 'group-graph-rules', options: { min: 0 }, note: 'Fewer nodes are a warning.' }),
		input('maxNodes', 'Max Nodes', 'integer', 'input', {
			width: 'half',
			group: 'group-graph-rules',
			options: { min: 0, placeholder: '$t:unlimited' },
			note: 'More nodes are an error.',
		}),
		input('maxEdges', 'Max Connections', 'integer', 'input', {
			width: 'half',
			group: 'group-graph-rules',
			options: { min: 0, placeholder: '$t:unlimited' },
			note: 'More connections are an error.',
		}),
		input('entryNodeTypes', 'Entry Node Types', 'json', 'select-multiple-dropdown', {
			width: 'half',
			group: 'group-graph-rules',
			options: { choices: choices.nodeTypes, placeholder: 'None' },
			note: 'The node types a graph starts from.',
		}),
		input('requireReachableFromEntry', 'Reachability', 'boolean', 'boolean', {
			width: 'half',
			group: 'group-graph-rules',
			options: { label: 'Require reachability' },
			fallback: DEFAULTS.requireReachableFromEntry,
			note: 'Every node must be reachable from an entry node; others are warnings. Needs at least one entry node type.',
		}),
		input('requireConnected', 'Connectedness', 'boolean', 'boolean', {
			width: 'half',
			group: 'group-graph-rules',
			options: { label: 'Require a connection' },
			fallback: DEFAULTS.requireConnected,
			note: 'Every node needs a connection, in or out; others are warnings.',
		}),

		section('group-severity', 'Severity Overrides', 'closed', { icon: 'report' }),
		repeater(
			'severity',
			'Overrides',
			[
				input('code', 'Issue Code', 'string', 'select-dropdown', {
					width: 'half',
					options: { choices: choices.issueCodes, placeholder: 'Choose an issue code' },
					note: 'The issue codes are listed in the ruleset reference, with their built-in severity.',
					display: 'raw',
				}),
				input('severity', 'Severity', 'string', 'select-dropdown', {
					width: 'half',
					options: { choices: SEVERITY_CHOICES, placeholder: 'Choose a severity' },
					note: 'Only errors can block a save; Off removes the issue.',
					display: 'raw',
				}),
			],
			{
				template: '{{code}}: {{severity}}',
				addLabel: 'Add Override',
				placeholder: 'No overrides: every issue has its built-in severity.',
				headerPlaceholder: 'New Override',
				group: 'group-severity',
				note: 'Changes the severity of an issue code everywhere: the issues panel, the counts, the display and the server.',
			},
		),

		section('group-starter', 'Starter Graph', 'closed', { icon: 'play_circle' }),
		notice(
			'notice-starter',
			'What **Create** puts into a new graph. Without starter nodes, Create seeds the **Min Instances** nodes of every node type that is not deprecated, in the order the types are declared, 360 units apart. The starter must be a graph that can be saved: no denied pairs, no second connection on a single-connection output, no more nodes than Max Instances.',
			'group-starter',
		),
		repeater(
			'starterNodes',
			'Nodes',
			[
				input('ref', 'Ref', 'string', 'input', {
					width: 'half',
					options: { ...KEY_INPUT, placeholder: 'start' },
					note: 'A name for the node, unique within the starter, used by its connections. Replaced by a generated id.',
					display: 'raw',
				}),
				input('type', '$t:type', 'string', 'select-dropdown', { width: 'half', options: { choices: choices.nodeTypes, placeholder: 'Choose a node type' }, display: 'raw' }),
				input('x', 'X', 'float', 'input', { width: 'half', options: { step: 18, placeholder: '0' }, note: 'Canvas units at 100% zoom; multiples of 18 sit on the grid.' }),
				input('y', 'Y', 'float', 'input', { width: 'half', options: { step: 18, placeholder: '0' } }),
				input('data', 'Data', 'json', 'input-code', {
					width: 'full',
					options: { language: 'JSON', lineNumber: false, placeholder: '{ "title": "Request received" }' },
					note: "Field values as a JSON object, merged over the type's field defaults.",
				}),
			],
			{
				template: '{{ref}} ({{type}})',
				addLabel: 'Add Node',
				placeholder: 'No starter nodes: Create seeds the Min Instances nodes.',
				headerPlaceholder: 'New Node',
				group: 'group-starter',
			},
		),
		repeater(
			'starterEdges',
			'Connections',
			[
				input('source', 'Source', 'string', 'select-dropdown', { width: 'half', options: { choices: choices.starterRefs, placeholder: 'Choose a node' }, display: 'raw' }),
				input('sourceHandle', 'Source Port', 'string', 'input', {
					width: 'half',
					options: { ...KEY_INPUT, placeholder: 'next' },
					note: "An output of the source node's type, including dynamic outputs such as `branches.0`.",
					display: 'raw',
				}),
				input('target', 'Target', 'string', 'select-dropdown', { width: 'half', options: { choices: choices.starterRefs, placeholder: 'Choose a node' }, display: 'raw' }),
				input('targetHandle', 'Target Port', 'string', 'input', {
					width: 'half',
					options: { ...KEY_INPUT, placeholder: 'in' },
					note: "An input of the target node's type.",
					display: 'raw',
				}),
				input('type', '$t:type', 'string', 'select-dropdown', {
					width: 'half',
					options: { choices: choices.edgeTypes, allowNone: true, placeholder: "The output's first allowed type" },
					note: 'Must be allowed on the output.',
				}),
				input('data', 'Data', 'json', 'input-code', {
					width: 'full',
					options: { language: 'JSON', lineNumber: false, placeholder: '{ "label": "Approved" }' },
					note: "Field values as a JSON object, merged over the edge type's field defaults.",
				}),
			],
			{
				template: '{{source}}.{{sourceHandle}} → {{target}}.{{targetHandle}}',
				addLabel: 'Add Connection',
				placeholder: 'No starter connections',
				headerPlaceholder: 'New Connection',
				group: 'group-starter',
			},
		),
	]);
}
