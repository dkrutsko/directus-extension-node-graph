import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compileRuleset, exampleRuleset } from '../src/shared/core';
import { RULESET_EXAMPLES, blankRuleset, simpleApprovalRuleset } from '../src/shared/options-editor/examples';
import { collectChoices, rulesetFormFields, type FormFieldDefinition } from '../src/shared/options-editor/form-fields';
import { inspectJson, rulesetText } from '../src/shared/options-editor/json-draft';
import {
	RAW_KEY,
	fieldFromRow,
	fieldToRow,
	fromViewModel,
	parseDefaultValue,
	toViewModel,
	viewModelNotes,
	type RulesetViewModel,
	type ViewItem,
} from '../src/shared/options-editor/view-model';

type Obj = Record<string, any>;

const examplesDir = new URL('../examples/', import.meta.url);
const exampleText = (name: string) => readFileSync(new URL(name, examplesDir), 'utf8');

/** toViewModel() that must succeed. */
function read(raw: unknown) {
	const result = toViewModel(raw);
	if (!result.ok) throw new Error(`not readable:\n${result.reasons.join('\n')}`);
	return result;
}

/** The ruleset with `change` applied to its view model, as the form would store it. */
function edit(raw: unknown, change: (vm: RulesetViewModel) => void): Obj {
	const { vm, base } = read(raw);
	change(vm);
	return fromViewModel(vm, base);
}

function copy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function rows(value: unknown): ViewItem[] {
	return value as ViewItem[];
}

function find(list: unknown, key: string, by = 'key'): ViewItem {
	const item = rows(list).find((entry) => entry[by] === key);
	if (!item) throw new Error(`no row ${key}`);
	return item;
}

/**
 * What the stock Repeater does to a row when anything in its drawer changes:
 * every field default is merged in (interfaces/list/list.vue `trackEdits`).
 */
function withRepeaterDefaults(row: ViewItem, fields: FormFieldDefinition[]): ViewItem {
	const defaults: ViewItem = {};

	for (const field of fields) {
		const value = field.schema?.default_value;
		if (value !== undefined && value !== null) defaults[field.field] = value;
	}

	return Object.assign(row, defaults, { ...row });
}

function repeaterFields(fields: FormFieldDefinition[], key: string): FormFieldDefinition[] {
	const field = fields.find((candidate) => candidate.field === key);
	const options = field?.meta['options'] as { fields?: FormFieldDefinition[] } | undefined;
	if (!options?.fields) throw new Error(`no repeater ${key}`);
	return options.fields;
}

describe('round trip', () => {
	test.each(['approval-workflow.json', 'simple-approval.json'])('%s comes back exactly, key order included', (name) => {
		const parsed = JSON.parse(exampleText(name));
		const { vm, base } = read(parsed);

		const back = fromViewModel(vm, base);
		expect(back).toEqual(parsed);
		expect(JSON.stringify(back)).toBe(JSON.stringify(parsed));
	});

	test('a ruleset stored as JSON text reads the same, and says so', () => {
		const text = exampleText('approval-workflow.json');
		const result = read(text);

		expect(result.fromText).toBe(true);
		expect(fromViewModel(result.vm, result.base)).toEqual(JSON.parse(text));
	});

	test('the model is flat: no stored object leaks into it except under $raw', () => {
		const { vm } = read(exampleRuleset);
		const task = find(vm.nodeTypes, 'task');

		expect(task['minInstances']).toBeUndefined();
		expect(task[RAW_KEY]).toEqual(exampleRuleset.nodeTypes[1]);
		expect(find(task['fields'], 'assignee', 'field')['interface']).toBe('select-dropdown');
		expect(find(vm.nodeTypes, 'condition')['dynamicPlacement']).toBe('start');
		expect(vm.severity).toBeUndefined();
		expect(rows(vm.starterNodes).map((node) => [node['ref'], node['x'], node['y']])).toEqual([
			['start', 0, 0],
			['end', 480, 0],
		]);
	});

	test('nothing stored reads as an empty model, and an empty model writes nothing', () => {
		for (const raw of [undefined, null, '', '  ']) {
			const result = read(raw);
			expect(result.vm).toEqual({});
			expect(result.base).toBeNull();
		}

		expect(fromViewModel({}, null)).toEqual({});
	});

	test('the examples offered by Load Example are the example files', () => {
		expect(simpleApprovalRuleset).toEqual(JSON.parse(exampleText('simple-approval.json')));
		expect(RULESET_EXAMPLES[0]!.create()).toEqual(JSON.parse(exampleText('approval-workflow.json')));
		expect(RULESET_EXAMPLES.map((example) => example.name)).toEqual(['Approval workflow', 'Simple approval', 'Blank']);

		// A fresh copy every time.
		expect(RULESET_EXAMPLES[1]!.create()).not.toBe(RULESET_EXAMPLES[1]!.create());

		// Blank asks for a node type, and nothing else.
		expect(compileRuleset(blankRuleset).problems).toEqual(['nodeTypes: must declare at least one node type.']);
	});
});

describe('preservation', () => {
	const tagged = (): Obj => {
		const ruleset = copy(exampleRuleset) as Obj;

		ruleset['x-top'] = { note: 'kept' };
		ruleset['dataTypes'][0]['x-data'] = 1;
		ruleset['nodeTypes'][1]['x-node'] = [1, 2];
		ruleset['nodeTypes'][1]['limits'] = { 'x-limits': true };
		ruleset['nodeTypes'][1]['fields'][1]['x-field'] = 'f';
		ruleset['nodeTypes'][1]['fields'][1]['meta']['conditions'] = [{ name: 'hide', rule: { title: { _null: true } }, hidden: true }];
		ruleset['nodeTypes'][1]['fields'][1]['meta']['sort'] = 7;
		ruleset['nodeTypes'][1]['fields'][1]['meta']['x-meta'] = 'm';
		ruleset['nodeTypes'][1]['fields'][2]['schema']['x-schema'] = 's';
		ruleset['nodeTypes'][1]['inputs'][0]['x-port'] = 'p';
		ruleset['nodeTypes'][3]['dynamicOutputs']['x-dynamic'] = 'd';
		ruleset['nodeTypes'][3]['dynamicOutputs']['port']['x-dynamic-port'] = 'dp';
		ruleset['edgeTypes'][1]['style']['x-style'] = 'st';
		ruleset['connectionRules']['x-rules'] = 'r';
		ruleset['connectionRules']['pairs']['x-pairs'] = 'pp';
		ruleset['connectionRules']['pairs']['rules'][0]['x-rule'] = 'rr';
		ruleset['graphRules']['x-graph'] = 'g';
		ruleset['starter']['x-starter'] = 'sx';
		ruleset['starter']['nodes'][0]['x-starter-node'] = 'sn';
		ruleset['starter']['nodes'][0]['position']['x-position'] = 'pos';
		ruleset['severity'] = { cycle: 'warning' };
		return ruleset;
	};

	test('unknown keys at every level survive the round trip', () => {
		const ruleset = tagged();
		const { vm, base } = read(ruleset);
		expect(JSON.stringify(fromViewModel(vm, base))).toBe(JSON.stringify(ruleset));
	});

	test('unknown keys, meta.conditions and meta.sort survive edits of the same objects', () => {
		const ruleset = tagged();

		const result = edit(ruleset, (vm) => {
			vm.name = 'Renamed';
			const task = find(vm.nodeTypes, 'task');
			task['label'] = 'Job';
			task['minInstances'] = 2;
			find(task['fields'], 'assignee', 'field')['name'] = 'Owner';
			find(task['fields'], 'due_days', 'field')['defaultValue'] = '5';
			find(task['inputs'], 'in')['label'] = 'Input';
			find(vm.nodeTypes, 'condition')['dynamicLabelTemplate'] = 'Branch {{label}}';
			find(vm.nodeTypes, 'condition')['dynamicMaxConnections'] = 2;
			find(vm.edgeTypes, 'timeout')['animated'] = true;
			vm.allowCycles = false;
			rows(vm.pairRules)[0]!['message'] = 'No.';
			vm.maxEdges = 500;
			rows(vm.starterNodes)[0]!['x'] = 18;
		});

		const expected = tagged();
		expected['name'] = 'Renamed';
		expected['nodeTypes'][1]['label'] = 'Job';
		expected['nodeTypes'][1]['limits']['minInstances'] = 2;
		expected['nodeTypes'][1]['fields'][1]['name'] = 'Owner';
		expected['nodeTypes'][1]['fields'][2]['schema']['default_value'] = 5;
		expected['nodeTypes'][1]['inputs'][0]['label'] = 'Input';
		expected['nodeTypes'][3]['dynamicOutputs']['labelTemplate'] = 'Branch {{label}}';
		expected['nodeTypes'][3]['dynamicOutputs']['port']['maxConnections'] = 2;
		expected['edgeTypes'][1]['style']['animated'] = true;
		expected['connectionRules']['allowCycles'] = false;
		expected['connectionRules']['pairs']['rules'][0]['message'] = 'No.';
		expected['graphRules']['maxEdges'] = 500;
		expected['starter']['nodes'][0]['position']['x'] = 18;

		expect(result).toEqual(expected);
		expect(result['nodeTypes'][1]['fields'][1]['meta']['conditions']).toEqual(tagged()['nodeTypes'][1]['fields'][1]['meta']['conditions']);
		// Existing keys keep their place; `animated` goes where the format puts it (after `dashed` and `color`).
		expect(Object.keys(result['edgeTypes'][1]['style'])).toEqual(['path', 'dashed', 'color', 'animated', 'marker', 'x-style']);
	});

	test('array order is kept, and reordering rows reorders the stored list', () => {
		const result = edit(exampleRuleset, (vm) => {
			vm.nodeTypes = [...rows(vm.nodeTypes)].reverse();
			const task = find(vm.nodeTypes, 'task');
			task['fields'] = [...rows(task['fields'])].reverse();
		});

		expect(result['nodeTypes'].map((type: Obj) => type['key'])).toEqual(exampleRuleset.nodeTypes.map((type) => type.key).reverse());
		expect(result['nodeTypes'][5]['fields'].map((field: Obj) => field['field'])).toEqual(['due_days', 'assignee', 'title']);
		expect(result['nodeTypes'][5]).toEqual({ ...exampleRuleset.nodeTypes[1], fields: [...exampleRuleset.nodeTypes[1]!.fields!].reverse() });
	});

	test('defaults that were absent are not written, even when the Repeater fills them in', () => {
		const fields = rulesetFormFields(collectChoices(read(simpleApprovalRuleset).vm));
		const nodeTypeFields = repeaterFields(fields, 'nodeTypes');
		const edgeTypeFields = repeaterFields(fields, 'edgeTypes');
		const outputFields = repeaterFields(nodeTypeFields, 'outputs');
		const fieldFields = repeaterFields(nodeTypeFields, 'fields');

		const result = edit(simpleApprovalRuleset, (vm) => {
			for (const nodeType of rows(vm.nodeTypes)) {
				withRepeaterDefaults(nodeType, nodeTypeFields);
				for (const output of rows(nodeType['outputs'] ?? [])) withRepeaterDefaults(output, outputFields);
				for (const field of rows(nodeType['fields'] ?? [])) withRepeaterDefaults(field, fieldFields);
			}

			for (const edgeType of rows(vm.edgeTypes)) withRepeaterDefaults(edgeType, edgeTypeFields);

			// What the top-level form shows for absent keys, picked explicitly.
			vm.version = 1;
			vm.allowMultiEdges = false;
			vm.requireConnected = false;
		});

		expect(result).toEqual(simpleApprovalRuleset);

		// The Repeater did fill them in: the test would pass vacuously otherwise.
		expect(find(read(simpleApprovalRuleset).vm.nodeTypes, 'task')['deletable']).toBeUndefined();
		expect(nodeTypeFields.find((field) => field.field === 'deletable')?.schema?.default_value).toBe(true);
	});

	test('defaults that were present stay, and an explicit default typed again is kept', () => {
		const ruleset = copy(exampleRuleset) as Obj;
		ruleset['nodeTypes'][1]['deletable'] = true;

		const result = edit(ruleset, (vm) => {
			find(vm.nodeTypes, 'task')['deletable'] = true;
			vm.typeCheck = 'strict';
			find(vm.edgeTypes, 'flow')['dashed'] = false;
		});

		expect(result).toEqual(ruleset);
		expect(result['edgeTypes'][0]['style']).toEqual({ path: 'bezier', dashed: false, marker: 'arrow' });
		expect(result['connectionRules']['typeCheck']).toBe('strict');
	});

	test('blank form values mean absent, but stored blanks stay as stored', () => {
		const ruleset = copy(exampleRuleset) as Obj;
		ruleset['nodeTypes'][0]['description'] = '';
		ruleset['nodeTypes'][1]['fields'][0]['meta']['note'] = null;
		ruleset['dataTypes'][1]['accepts'] = [];

		expect(edit(ruleset, () => {})).toEqual(ruleset);

		const result = edit(ruleset, (vm) => {
			find(vm.nodeTypes, 'task')['label'] = '';
			find(vm.nodeTypes, 'task')['category'] = null;
			find(vm.nodeTypes, 'approval')['summaryFields'] = [];
			find(vm.nodeTypes, 'start')['minInstances'] = null;
			find(vm.nodeTypes, 'start')['maxInstances'] = null;
			find(find(vm.nodeTypes, 'task')['fields'], 'assignee', 'field')['options'] = {};
			vm.pairMode = null;
			vm.pairRules = null;
		});

		expect(result['nodeTypes'][1]).not.toHaveProperty('label');
		expect(result['nodeTypes'][1]).not.toHaveProperty('category');
		expect(result['nodeTypes'][2]).not.toHaveProperty('summaryFields');
		expect(result['nodeTypes'][0]).not.toHaveProperty('limits');
		expect(result['nodeTypes'][1]['fields'][1]['meta']).not.toHaveProperty('options');
		expect(result['connectionRules']).not.toHaveProperty('pairs');
		expect(result['nodeTypes'][0]['description']).toBe('');
		expect(result['nodeTypes'][1]['fields'][0]['meta']['note']).toBeNull();
		expect(result['dataTypes'][1]['accepts']).toEqual([]);
	});

	test('nulls and empty containers that were stored come back as they were', () => {
		const ruleset = {
			key: 'odd',
			nodeTypes: [{ key: 'a', limits: {}, dynamicOutputs: null, fields: [{ field: 'f', type: 'string', meta: null, schema: { default_value: null } }] }],
			edgeTypes: [],
			connectionRules: null,
			graphRules: {},
			severity: {},
			starter: { nodes: [] },
		};

		const { vm, base } = read(ruleset);
		expect(JSON.stringify(fromViewModel(vm, base))).toBe(JSON.stringify(ruleset));
	});
});

describe('field definitions', () => {
	const field = {
		field: 'assignee',
		name: 'Assignee',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			width: 'half',
			options: { choices: [{ text: 'A', value: 'a' }] },
			conditions: [{ rule: { title: { _empty: true } }, readonly: true }],
			sort: 3,
		},
		schema: { default_value: 'a' },
	};

	test('a field becomes a flat row, the way the stock "Edit Fields" flattens meta', () => {
		const row = fieldToRow(field);

		expect({ ...row, [RAW_KEY]: undefined }).toEqual({
			field: 'assignee',
			name: 'Assignee',
			type: 'string',
			interface: 'select-dropdown',
			width: 'half',
			options: { choices: [{ text: 'A', value: 'a' }] },
			defaultValue: 'a',
			[RAW_KEY]: undefined,
		});

		expect(fieldFromRow(row)).toEqual(field);
		expect(JSON.stringify(fieldFromRow(row))).toBe(JSON.stringify(field));
	});

	test('edits keep the meta keys the form does not show', () => {
		const row = fieldToRow(field);
		row['interface'] = 'select-radio';
		row['required'] = true;
		row['note'] = 'Who does it';
		row['display'] = 'formatted-value';
		row['display_options'] = { bold: true };

		expect(fieldFromRow(row)).toEqual({
			...field,
			meta: { ...field.meta, interface: 'select-radio', required: true, note: 'Who does it', display: 'formatted-value', display_options: { bold: true } },
		});
	});

	test('a new row becomes a NodeGraphField in the documented shape', () => {
		expect(fieldFromRow({ field: 'due', name: 'Due', type: 'integer', interface: 'input', width: 'half', required: false, hidden: false, defaultValue: '3' })).toEqual({
			field: 'due',
			name: 'Due',
			type: 'integer',
			meta: { interface: 'input', width: 'half' },
			schema: { default_value: 3 },
		});

		expect(fieldFromRow({ field: 'note', type: 'alias', interface: 'presentation-notice', width: 'full', options: { text: 'Hi' } })).toEqual({
			field: 'note',
			type: 'alias',
			meta: { interface: 'presentation-notice', options: { text: 'Hi' } },
		});

		expect(fieldFromRow({})).toEqual({});
	});

	test('default values are typed text, converted by the field type', () => {
		const cases: Array<[string, string, unknown]> = [
			['true', 'boolean', true],
			['FALSE', 'boolean', false],
			['3', 'integer', 3],
			['-12', 'integer', -12],
			['2.5', 'float', 2.5],
			['{"a": [1, 2]}', 'json', { a: [1, 2] }],
			['["x"]', 'json', ['x']],
			['7', 'json', 7],
			['a, b ,c', 'csv', ['a', 'b', 'c']],
			['["a b", "c"]', 'csv', ['a b', 'c']],
			['3', 'string', '3'],
			['true', 'text', 'true'],
			['9007199254740993', 'bigInteger', '9007199254740993'],
			['1.10', 'decimal', '1.10'],
			['2026-01-01', 'date', '2026-01-01'],
			['plain', undefined as unknown as string, 'plain'],
		];

		for (const [text, type, value] of cases) {
			expect(parseDefaultValue(text, type), `${type}: ${text}`).toEqual({ value });
		}

		expect(parseDefaultValue('soon', 'integer')).toEqual({ value: 'soon', problem: '"soon" is not a whole number' });
		expect(parseDefaultValue('1.5', 'integer').problem).toBeDefined();
		expect(parseDefaultValue('yes', 'boolean').problem).toBeDefined();
		expect(parseDefaultValue('{', 'json')).toEqual({ value: '{', problem: '"{" is not valid JSON' });
	});

	test('stored default values show as text and are kept as stored until the text changes', () => {
		const stored = { field: 'x', type: 'integer', schema: { default_value: '3' } };
		const row = fieldToRow(stored);

		expect(row['defaultValue']).toBe('3');
		expect(fieldFromRow(row)).toEqual(stored);

		row['defaultValue'] = '4';
		expect(fieldFromRow(row)).toEqual({ ...stored, schema: { default_value: 4 } });

		expect(fieldToRow({ field: 'j', type: 'json', schema: { default_value: { a: 1 } } })['defaultValue']).toBe('{"a":1}');
		expect(fieldToRow({ field: 'b', type: 'boolean', schema: { default_value: false } })['defaultValue']).toBe('false');

		const cleared = fieldToRow({ field: 'x', type: 'integer', schema: { default_value: 3 } });
		cleared['defaultValue'] = '';
		expect(fieldFromRow(cleared)).toEqual({ field: 'x', type: 'integer' });
	});
});

describe('editing through the view model', () => {
	test('adding a node type with a field and ports, a pair rule and a severity override', () => {
		const result = edit(simpleApprovalRuleset, (vm) => {
			rows(vm.nodeTypes).push({
				key: 'review',
				label: 'Review',
				icon: 'rate_review',
				category: 'Steps',
				deprecated: false,
				deletable: true,
				titleTemplate: 'Review by {{reviewer}}',
				summaryFields: ['reviewer'],
				fields: [
					{
						field: 'reviewer',
						name: 'Reviewer',
						type: 'string',
						width: 'full',
						interface: 'select-dropdown',
						options: { choices: [{ text: 'Lead', value: 'lead' }] },
						defaultValue: 'lead',
					},
				],
				inputs: [{ key: 'in', label: 'In', dataType: 'flow', minConnections: 1 }],
				outputs: [{ key: 'done', label: 'Done', dataType: 'flow', maxConnections: 1, edgeTypes: ['flow'], newEdgeType: 'flow' }],
				dynamicPlacement: 'end',
				dynamicDataType: 'any',
				dynamicMinConnections: 0,
			});

			rows(vm.pairRules).push({ source: 'review', sourcePort: 'done', target: 'start', message: 'Reviews do not restart.' });
			vm.severity = [{ code: 'min_connections', severity: 'off' }];
		});

		expect(result['nodeTypes'][4]).toEqual({
			key: 'review',
			label: 'Review',
			icon: 'rate_review',
			category: 'Steps',
			titleTemplate: 'Review by {{reviewer}}',
			summaryFields: ['reviewer'],
			fields: [
				{
					field: 'reviewer',
					name: 'Reviewer',
					type: 'string',
					meta: { interface: 'select-dropdown', options: { choices: [{ text: 'Lead', value: 'lead' }] } },
					schema: { default_value: 'lead' },
				},
			],
			inputs: [{ key: 'in', label: 'In', dataType: 'flow', minConnections: 1 }],
			outputs: [{ key: 'done', label: 'Done', dataType: 'flow', maxConnections: 1, edgeTypes: ['flow'] }],
		});

		expect(result['connectionRules']['pairs']['rules'][1]).toEqual({ source: 'review', sourcePort: 'done', target: 'start', message: 'Reviews do not restart.' });
		expect(result['severity']).toEqual({ min_connections: 'off' });
		// The new `severity` goes between graphRules and the end, where the format puts it.
		expect(Object.keys(result).slice(-2)).toEqual(['graphRules', 'severity']);

		expect(compileRuleset(result).problems).toEqual([]);
		expect(result['nodeTypes'].slice(0, 4)).toEqual(simpleApprovalRuleset.nodeTypes);
	});

	test('adding a port to an existing type, and renaming a node type key', () => {
		const result = edit(exampleRuleset, (vm) => {
			rows(find(vm.nodeTypes, 'notify')['outputs']).push({ key: 'failed', label: 'Failed', dataType: 'event' });
			find(vm.nodeTypes, 'end')['key'] = 'finish';
		});

		const expected = copy(exampleRuleset) as Obj;
		expected['nodeTypes'][4]['outputs'].push({ key: 'failed', label: 'Failed', dataType: 'event' });
		expected['nodeTypes'][5]['key'] = 'finish';
		expect(result).toEqual(expected);

		// A rename does not follow references: the compiler reports them, and the form lists them as not defined.
		expect(compileRuleset(result).problems).toEqual([
			'connectionRules.pairs.rules[0].target: "end" is not a defined node type.',
			'starter.nodes[1].type: "end" is not a defined node type.',
		]);
		const choices = collectChoices(read(result).vm);
		expect(choices.nodeTypes.map((choice) => choice.value)).toContain('end');
		expect(choices.nodeTypes.find((choice) => choice.value === 'end')?.text).toBe('end (not defined)');
	});

	test('an output keeps its edge type order; New Connections puts its type first', () => {
		const flowFirst = edit(exampleRuleset, () => {});
		expect(flowFirst['nodeTypes'][1]['outputs'][0]['edgeTypes']).toEqual(['flow', 'timeout']);

		const timeoutFirst = edit(exampleRuleset, (vm) => {
			find(find(vm.nodeTypes, 'task')['outputs'], 'next')['newEdgeType'] = 'timeout';
		});
		expect(timeoutFirst['nodeTypes'][1]['outputs'][0]['edgeTypes']).toEqual(['timeout', 'flow']);

		// The multi-select emits its values in choice order; the stored order wins for values that stay.
		const kept = edit(timeoutFirst, (vm) => {
			const next = find(find(vm.nodeTypes, 'task')['outputs'], 'next');
			next['edgeTypes'] = ['flow', 'timeout'];
		});
		expect(kept['nodeTypes'][1]['outputs'][0]['edgeTypes']).toEqual(['timeout', 'flow']);

		// Removing the first type makes the next one first; a stale New Connections value is ignored.
		const removed = edit(timeoutFirst, (vm) => {
			find(find(vm.nodeTypes, 'task')['outputs'], 'next')['edgeTypes'] = ['flow'];
		});
		expect(removed['nodeTypes'][1]['outputs'][0]['edgeTypes']).toEqual(['flow']);
	});

	test('incomplete rows are kept so they can be finished, and the problems say what is missing', () => {
		const result = edit(simpleApprovalRuleset, (vm) => {
			rows(vm.nodeTypes).push({ label: 'Draft' });
			rows(find(vm.nodeTypes, 'task')['fields']).push({ name: 'Untitled' });
			vm.severity = [{ code: 'cycle' }, { severity: 'warning' }];
			vm.starterNodes = [{ ref: 'a' }];
		});

		expect(result['nodeTypes'][4]).toEqual({ label: 'Draft' });
		expect(result['nodeTypes'][1]['fields'][2]).toEqual({ name: 'Untitled' });
		expect(result['severity']).toEqual({ cycle: null });
		expect(result['starter']).toEqual({ nodes: [{ ref: 'a' }] });

		expect(compileRuleset(result).problems).toEqual(
			expect.arrayContaining([
				'nodeTypes[4].key: is required.',
				'nodeTypes[1].fields[2].field: is required.',
				'severity.cycle: must be "error", "warning" or "off".',
				'starter.nodes[0].position: must be { "x": number, "y": number }.',
			]),
		);

		// The override without a code cannot be stored; the form keeps it and says so.
		const { vm } = read(result);
		vm.severity = [...rows(vm.severity), { severity: 'warning' }];
		expect(viewModelNotes(vm)).toEqual(['Severity Overrides, row 2: choose an issue code. The row is not saved until it has one.']);
	});

	test('notes about entries that are not stored as entered', () => {
		const vm: RulesetViewModel = {
			severity: [
				{ code: 'cycle', severity: 'warning' },
				{ code: 'cycle', severity: 'off' },
			],
			nodeTypes: [{ key: 't', fields: [{ field: 'n', type: 'integer', defaultValue: 'many' }] }],
		};

		expect(viewModelNotes(vm)).toEqual([
			'Severity Overrides: "cycle" is listed 2 times; only the last row counts.',
			'Node type "t", field "n": the default value "many" is not a whole number; it is saved as text.',
		]);
		expect(fromViewModel(vm, null)['severity']).toEqual({ cycle: 'off' });
	});

	test('a pair mode picked before the first rule gets the required empty list', () => {
		const result = edit({ key: 'k', nodeTypes: [{ key: 'a' }] }, (vm) => {
			vm.pairMode = 'deny';
		});

		expect(result['connectionRules']).toEqual({ pairs: { mode: 'deny', rules: [] } });
		expect(compileRuleset(result).problems).toEqual([]);
	});

	test('a new ruleset built in the form gets keys in the documented order', () => {
		const result = fromViewModel(
			{
				nodeTypes: [{ key: 'step', inputs: [{ key: 'in' }], outputs: [{ key: 'out' }] }],
				direction: 'TB',
				name: 'Tiny',
				key: 'tiny',
				graphRules: undefined,
				requireConnected: true,
			},
			null,
		);

		expect(JSON.stringify(result)).toBe(
			JSON.stringify({
				key: 'tiny',
				name: 'Tiny',
				direction: 'TB',
				nodeTypes: [{ key: 'step', inputs: [{ key: 'in' }], outputs: [{ key: 'out' }] }],
				graphRules: { requireConnected: true },
			}),
		);
	});
});

describe('rulesets the form cannot show', () => {
	test('text that is not JSON, and JSON that is not an object', () => {
		expect(toViewModel('{ "key": ')).toMatchObject({ ok: false, text: '{ "key": ' });
		expect(toViewModel('[1, 2]')).toMatchObject({ ok: false, reasons: ['The ruleset must be a JSON object.'] });
		expect(toViewModel(42)).toMatchObject({ ok: false });
	});

	test('values of a shape a stock interface cannot give back', () => {
		const result = toViewModel({
			key: 'k',
			version: '2',
			nodeTypes: [{ key: 'a', deprecated: 'yes', fields: {}, outputs: [{ key: 'o', edgeTypes: 'flow' }] }, 'b'],
			severity: { cycle: 1 },
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;

		expect(result.reasons).toEqual([
			'version: must be a number to be edited in the form.',
			'nodeTypes[0].deprecated: must be true or false to be edited in the form.',
			'nodeTypes[0].fields: must be a list to be edited in the form.',
			'nodeTypes[0].outputs[0].edgeTypes: must be a list of text to be edited in the form.',
			'nodeTypes[1]: must be an object to be edited in the form.',
			'severity.cycle: must be text to be edited in the form.',
		]);
		expect(JSON.parse(result.text)).toMatchObject({ key: 'k', version: '2' });
	});

	test('a ruleset that would not come back unchanged is refused rather than altered', () => {
		const result = toViewModel(JSON.parse('{"key": "k", "nodeTypes": [{"key": "a", "__proto__": {"x": 1}}]}'));
		expect(result.ok).toBe(false);
	});
});

describe('the form', () => {
	const fields = rulesetFormFields(collectChoices(read(exampleRuleset).vm));

	test('every key of the model is a field of the form (v-form drops other keys when a section applies)', () => {
		const keys = new Set(fields.map((field) => field.field));
		const vm = read({ ...exampleRuleset, severity: { cycle: 'warning' } }).vm;

		for (const key of Object.keys(vm)) expect(keys.has(key), key).toBe(true);

		const nested = (list: unknown, definitions: FormFieldDefinition[]) => {
			const known = new Set(definitions.map((definition) => definition.field));
			for (const row of rows(list ?? [])) {
				for (const key of Object.keys(row)) if (key !== RAW_KEY) expect(known.has(key), key).toBe(true);
			}
		};

		const nodeTypeFields = repeaterFields(fields, 'nodeTypes');
		nested(vm.dataTypes, repeaterFields(fields, 'dataTypes'));
		nested(vm.nodeTypes, nodeTypeFields);
		nested(vm.edgeTypes, repeaterFields(fields, 'edgeTypes'));
		nested(vm.pairRules, repeaterFields(fields, 'pairRules'));
		nested(vm.severity, repeaterFields(fields, 'severity'));
		nested(vm.starterNodes, repeaterFields(fields, 'starterNodes'));

		for (const nodeType of rows(vm.nodeTypes)) {
			nested(nodeType['fields'], repeaterFields(nodeTypeFields, 'fields'));
			nested(nodeType['inputs'], repeaterFields(nodeTypeFields, 'inputs'));
			nested(nodeType['outputs'], repeaterFields(nodeTypeFields, 'outputs'));
		}
	});

	test('sections are group-detail fields, lists are Repeaters, fields use the stock pickers', () => {
		const sections = fields.filter((field) => field.meta['interface'] === 'group-detail').map((field) => field.name);
		expect(sections).toEqual(['Ruleset', 'Data Types', 'Node Types', 'Edge Types', 'Connection Rules', 'Graph Rules', 'Severity Overrides', 'Starter Graph']);

		const fieldFields = repeaterFields(repeaterFields(fields, 'nodeTypes'), 'fields');
		const interfaces = Object.fromEntries(fieldFields.map((field) => [field.field, field.meta['interface']]));

		expect(interfaces).toMatchObject({
			interface: 'system-interface',
			options: 'system-interface-options',
			display: 'system-display',
			display_options: 'system-display-options',
		});
		expect(fieldFields.find((field) => field.field === 'interface')?.meta['options']).toEqual({ typeField: 'type' });
		expect(fieldFields.find((field) => field.field === 'options')?.meta['options']).toEqual({ interfaceField: 'interface' });

		// Every field has its place: v-form sorts by meta.sort within a group.
		for (const field of fields) expect(typeof field.meta['sort']).toBe('number');
	});

	test('choices come from the model, with "*" for pair rules and every issue code with its default', () => {
		const choices = collectChoices(read(exampleRuleset).vm);

		expect(choices.dataTypes.map((choice) => choice.value)).toEqual(['any', 'flow', 'event']);
		expect(choices.dataTypes[1]).toEqual({ text: 'Control flow (flow)', value: 'flow' });
		expect(choices.nodeTypesOrAny[0]).toEqual({ text: 'Any node type (*)', value: '*' });
		expect(choices.edgeTypes.map((choice) => choice.value)).toEqual(['flow', 'timeout']);
		expect(choices.jsonFieldKeys).toEqual([{ text: 'branches', value: 'branches' }]);
		expect(choices.starterRefs.map((choice) => choice.value)).toEqual(['start', 'end']);
		expect(choices.issueCodes).toHaveLength(24);
		expect(choices.issueCodes.find((choice) => choice.value === 'cycle')?.text).toBe('cycle (default: error)');
		expect(choices.fieldKeys).toContain('sla_hours');
	});

	test("a node type's drawer suggests its own fields for the summary, through stock field conditions on its key", () => {
		const nodeTypeFields = repeaterFields(fields, 'nodeTypes');
		const summary = nodeTypeFields.find((field) => field.field === 'summaryFields')!;
		const conditions = summary.meta['conditions'] as Array<{ rule: unknown; options: { presets: string[] } }>;

		expect(conditions.find((condition) => JSON.stringify(condition.rule) === '{"key":{"_eq":"task"}}')?.options.presets).toEqual(['title', 'assignee', 'due_days']);

		// Without a match (a new type) every field key is suggested.
		expect((summary.meta['options'] as { presets: string[] }).presets).toEqual(expect.arrayContaining(['title', 'assignee', 'sla_hours', 'branches']));

		// Selects are not narrowed: a select clears a value its choices lose.
		expect(nodeTypeFields.find((field) => field.field === 'dynamicField')!.meta['conditions']).toBeUndefined();
	});
});

describe('JSON editor', () => {
	test('reports parse errors, compile problems and what the form cannot show', () => {
		expect(inspectJson('')).toMatchObject({ state: 'empty' });
		expect(inspectJson('{ nope')).toMatchObject({ state: 'invalid' });
		expect(inspectJson('[]')).toMatchObject({ state: 'invalid', problems: ['The ruleset must be a JSON object ({ … }).'] });
		expect(inspectJson(exampleText('simple-approval.json'))).toMatchObject({ state: 'ok', problems: [], formReasons: [] });

		const broken = inspectJson('{"key": "k", "nodeTypes": "none"}');
		expect(broken.state).toBe('ok');
		expect(broken.problems).toEqual(['nodeTypes: must be a list.']);
		expect(broken.formReasons).toEqual(['nodeTypes: must be a list to be edited in the form.']);
	});

	test('starts from the stored text as it is, or pretty JSON with tabs', () => {
		expect(rulesetText(null)).toBe('');
		expect(rulesetText('{"a":1}')).toBe('{"a":1}');
		expect(`${rulesetText(exampleRuleset)}\n`).toBe(exampleText('approval-workflow.json'));
	});
});
