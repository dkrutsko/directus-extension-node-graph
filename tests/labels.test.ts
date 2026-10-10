import { describe, expect, test } from 'vitest';
import {
	edgeLabel,
	fieldSummary,
	getDocumentPorts,
	getPorts,
	nodeSummary,
	nodeTitle,
	renderTemplate,
	starterDocument,
	validateDocument,
} from '../src/shared/core';
import type { NodeGraphField } from '../src/shared/core';
import { doc, edge, example, node, validWorkflow, variant } from './helpers';

describe('renderTemplate', () => {
	const scope = { title: 'Review', nested: { deep: { value: 7 } }, list: ['a', 'b'], flag: true, zero: 0, items: [{ label: 'x' }] };

	test('replaces tokens with and without inner spaces, nested paths and indices', () => {
		expect(renderTemplate('{{title}} / {{ title }} / {{nested.deep.value}} / {{list.1}} / {{items.0.label}}', scope)).toBe('Review / Review / 7 / b / x');
	});

	test('renders missing values, objects and invalid paths as empty', () => {
		expect(renderTemplate('[{{missing}}][{{nested}}][{{nested.deep.nope}}][{{ not valid }}][{{a..b}}]', scope)).toBe('[][][][][]');
	});

	test('cannot reach prototypes or inherited properties', () => {
		const template = '{{constructor}}|{{__proto__}}|{{title.constructor.name}}|{{toString}}|{{nested.constructor}}|{{list.length}}|{{prototype}}';
		expect(renderTemplate(template, scope)).toBe('||||||');
	});

	test('without fields: numbers and booleans as text, arrays joined', () => {
		expect(renderTemplate('{{zero}} {{flag}} {{list}}', scope)).toBe('0 true a, b');
	});

	test('with fields: choice text, Yes/No, joined lists', () => {
		const fields: NodeGraphField[] = [
			{ field: 'who', type: 'string', meta: { interface: 'select-dropdown', options: { choices: [{ text: 'Team lead', value: 'team_lead' }] } } },
			{ field: 'many', type: 'json', meta: { interface: 'select-multiple-dropdown', options: { choices: [{ text: 'One', value: 1 }, { text: 'Two', value: 2 }] } } },
			{ field: 'flag', type: 'boolean' },
		];

		expect(renderTemplate('{{who}} · {{many}} · {{flag}} · {{other}}', { who: 'team_lead', many: [2, 1, 3], flag: false, other: 'x' }, fields)).toBe(
			'Team lead · Two, One, 3 · No · x',
		);
	});

	test('is plain text: markup passes through untouched and control characters are removed', () => {
		expect(renderTemplate('<b>{{title}}</b>', { title: '<img src=x onerror=alert(1)>' })).toBe('<b><img src=x onerror=alert(1)></b>');
		expect(renderTemplate('{{title}}', { title: 'a\u0000b\u0007c\nd' })).toBe('abc\nd');
	});

	test('tolerates junk input', () => {
		expect(renderTemplate(null, scope)).toBe('');
		expect(renderTemplate('{{title}}', null)).toBe('');
		expect(renderTemplate('{{title}}', 'string scope')).toBe('');
		expect(renderTemplate('no tokens', scope)).toBe('no tokens');
	});
});

describe('nodeTitle, edgeLabel, nodeSummary', () => {
	test('titles render from the template with choice text and fall back to the type label', () => {
		expect(nodeTitle(example, node('t', 'task', { title: 'Prepare' }))).toBe('Prepare');
		expect(nodeTitle(example, node('t', 'task', {}))).toBe('Task');
		expect(nodeTitle(example, node('a', 'approval', { approver: 'team_lead' }))).toBe('Approval by Team lead');
		expect(nodeTitle(example, node('a', 'approval', {}))).toBe('Approval');
		expect(nodeTitle(example, node('e', 'end', { outcome: 'cancelled' }))).toBe('End: Cancelled');
		expect(nodeTitle(example, node('e', 'end', {}))).toBe('End');
		expect(nodeTitle(example, node('n', 'notify', { channel: 'slack' }))).toBe('Notify via Slack');
		expect(nodeTitle(example, node('g', 'retired', {}))).toBe('retired');
		expect(nodeTitle(null, node('t', 'task', { title: 'X' }))).toBe('task');
	});

	test('titles collapse whitespace and are length-capped', () => {
		expect(nodeTitle(example, node('t', 'task', { title: '  Two\n\nlines  ' }))).toBe('Two lines');
		expect(nodeTitle(example, node('t', 'task', { title: 'x'.repeat(500) })).length).toBe(120);
	});

	test('edge labels', () => {
		expect(edgeLabel(example, edge('e', 'a.next', 'b.in', 'flow', { label: 'yes' }))).toBe('yes');
		expect(edgeLabel(example, edge('e', 'a.next', 'b.in', 'flow'))).toBe('');
		expect(edgeLabel(example, edge('e', 'a.next', 'b.in', undefined, { label: 'default type' }))).toBe('default type');
		expect(edgeLabel(example, edge('e', 'a.next', 'b.in', 'timeout', { after_hours: 4 }))).toBe('after 4 h');
		expect(edgeLabel(example, edge('e', 'a.next', 'b.in', 'timeout'))).toBe('');
		expect(edgeLabel(example, edge('e', 'a.next', 'b.in', 'warp', { label: 'x' }))).toBe('');
	});

	test('node summary lists non-empty summary fields with their names and formatted values', () => {
		expect(nodeSummary(example, node('t', 'task', { title: 'X', assignee: 'it', due_days: 2 }))).toEqual([
			{ label: 'Assignee', value: 'IT' },
			{ label: 'Due in (days)', value: '2' },
		]);

		expect(nodeSummary(example, node('t', 'task', { due_days: 0 }))).toEqual([{ label: 'Due in (days)', value: '0' }]);
		expect(nodeSummary(example, node('s', 'start', { title: 'X' }))).toEqual([]);
		expect(nodeSummary(example, node('g', 'retired', {}))).toEqual([]);
	});
});

describe('getPorts', () => {
	test('resolves sides, data types, colours, limits and edge types', () => {
		const ports = getPorts(example, node('a', 'approval'));

		expect(ports.inputs).toEqual([
			{
				key: 'in',
				label: 'In',
				direction: 'input',
				side: 'left',
				dataType: 'flow',
				dataTypeLabel: 'Control flow',
				color: 'var(--theme--primary)',
				minConnections: 1,
				maxConnections: null,
				edgeTypes: [],
				dynamic: false,
				declared: true,
			},
		]);

		expect(ports.outputs.map((port) => [port.key, port.label, port.side, port.dataType, port.maxConnections, port.edgeTypes])).toEqual([
			['approved', 'Approved', 'right', 'flow', 1, ['flow']],
			['rejected', 'Rejected', 'right', 'flow', 1, ['flow']],
			['escalate', 'Escalate', 'right', 'event', null, ['flow']],
		]);

		expect(getPorts(example, node('t', 'task')).outputs[0]!.edgeTypes).toEqual(['flow', 'timeout']);
	});

	test('expands dynamic outputs from the repeater, before the static ones (placement: start)', () => {
		const ports = getPorts(example, node('c', 'condition', { branches: [{ label: 'Left' }, {}, { label: '  Right  ' }] }));

		expect(ports.outputs.map((port) => [port.key, port.label, port.dynamic, port.maxConnections])).toEqual([
			['branches.0', 'Left', true, 1],
			['branches.1', '#2', true, 1],
			['branches.2', 'Right', true, 1],
			['else', 'Otherwise', false, 1],
		]);
	});

	test('top/bottom sides for TB rulesets; omitted edgeTypes means all, default first', () => {
		const ruleset = variant((copy) => {
			copy.direction = 'TB';
			copy.connectionRules!.defaultEdgeType = 'timeout';
			delete copy.nodeTypes.find((type) => type.key === 'notify')!.outputs![0]!.edgeTypes;
		});

		const ports = getPorts(ruleset, node('n', 'notify'));
		expect(ports.inputs.map((port) => port.side)).toEqual(['top', 'top']);
		expect(ports.outputs[0]).toMatchObject({ side: 'bottom', edgeTypes: ['timeout', 'flow'] });
	});

	test('adds placeholders for ports referenced by edges but not declared', () => {
		const document = doc([node('t', 'task'), node('g', 'retired')], [edge('x', 't.gone', 'g.in'), edge('y', 'g.out', 't.in')]);

		const task = getPorts(example, document.nodes[0]!, document.edges);
		expect(task.outputs.map((port) => [port.key, port.declared])).toEqual([
			['next', true],
			['gone', false],
		]);

		const ghost = getPorts(example, document.nodes[1]!, document.edges);
		expect(ghost.inputs.map((port) => [port.key, port.declared, port.color])).toEqual([['in', false, 'var(--theme--danger)']]);
		expect(ghost.outputs.map((port) => port.key)).toEqual(['out']);

		const all = getDocumentPorts(example, document);
		expect(all.get('t')).toEqual(task);
		expect(all.get('g')).toEqual(ghost);
	});

	test('results are cached per node object and frozen', () => {
		const item = node('a', 'approval');
		const first = getPorts(example, item);

		expect(getPorts(example, item)).toBe(first);
		expect(Object.isFrozen(first.outputs)).toBe(true);
		expect(Object.isFrozen(first.outputs[0])).toBe(true);
		expect(getPorts(example, { ...item })).not.toBe(first);
	});
});

describe('fieldSummary', () => {
	test('default text is pluralised', () => {
		expect(fieldSummary({}, example, starterDocument(example))).toBe('2 nodes · 0 connections');
		expect(fieldSummary(null, example, doc([node('s', 'start')], [edge('e', 's.next', 's.in')]))).toBe('1 node · 1 connection');
		expect(fieldSummary({ template: '   ' }, example, validWorkflow())).toBe('7 nodes · 9 connections');
	});

	test('custom templates see counts (0 for absent types), issue totals and the ruleset', () => {
		const template = '{{counts.approval}} approval(s), {{counts.task}} task(s) · {{errorCount}} errors, {{warningCount}} warnings · {{ruleset.name}} v{{ruleset.version}}';
		const document = starterDocument(example);

		expect(fieldSummary({ template }, example, document)).toBe('0 approval(s), 0 task(s) · 0 errors, 3 warnings · Approval workflow v1');
		expect(fieldSummary({ template }, example, validWorkflow())).toBe('1 approval(s), 1 task(s) · 0 errors, 0 warnings · Approval workflow v1');
	});

	test('uses given issues instead of validating again, and works without a ruleset', () => {
		const document = validWorkflow();
		const issues = validateDocument(example, starterDocument(example));

		expect(fieldSummary({ template: '{{warningCount}}' }, example, document, issues)).toBe('3');
		expect(fieldSummary({ template: '{{nodeCount}} / {{ruleset.name}}' }, null, document)).toBe('7 /');
		expect(fieldSummary({}, example, null)).toBe('');
	});
});
