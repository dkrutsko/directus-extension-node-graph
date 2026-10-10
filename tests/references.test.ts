import { describe, expect, test } from 'vitest';
import {
	asReference,
	canConnect,
	collectReferences,
	documentReferences,
	edgeLabel,
	exampleRuleset,
	formatValue,
	isReferenceField,
	nodeSummary,
	nodeTitle,
	renderTemplate,
	templatePaths,
	validateDocument,
	validateValue,
} from '../src/shared/core';
import type { ItemReference, NodeGraphField, ReferenceResolver, Ruleset } from '../src/shared/core';
import {
	labelKey,
	planReferenceRequest,
	referenceEndpoint,
	referenceLabel,
	referenceQuery,
	referenceTemplate,
	type ReferenceSchema,
} from '../src/shared/ui/reference-query';
import { guardSetup } from './guard-setup';
import { doc, edge, node, validWorkflow, variant } from './helpers';

/* Fixtures ------------------------------------------------------------------ */

const dropdown: NodeGraphField = {
	field: 'customer',
	name: 'Customer',
	type: 'json',
	meta: { interface: 'collection-item-dropdown', options: { selectedCollection: 'customers' } },
};

const multiple: NodeGraphField = {
	field: 'accounts',
	name: 'Accounts',
	type: 'json',
	meta: { interface: 'collection-item-multiple-dropdown', options: { selectedCollection: 'customers', template: '{{code}}' } },
};

const plain: NodeGraphField = { field: 'notes', name: 'Notes', type: 'json', meta: { interface: 'input-code' } };

const ref = (key: string | number, collection = 'customers'): ItemReference => ({ key, collection });

const NAMES: Record<string, string> = { 'customers:1': 'ssh-adserver', 'customers:2': 'Northwind', 'regions:7': 'North' };

/** A resolver like the editor's: knows some items, records what it was asked. */
function resolver() {
	const calls: Array<{ reference: ItemReference; field: string | undefined }> = [];

	const resolve: ReferenceResolver = (reference, field) => {
		calls.push({ reference, field: field?.field });
		return NAMES[`${reference.collection}:${reference.key}`];
	};

	return { resolve, calls };
}

/** The example ruleset with references: Start (titled by its customer), Task (a list of accounts) and the flow edge. */
const withReferences = variant((ruleset: Ruleset) => {
	const start = ruleset.nodeTypes.find((type) => type.key === 'start')!;
	start.fields = [...(start.fields ?? []), dropdown];
	start.titleTemplate = 'Start for {{customer}}';
	start.summaryFields = ['customer'];

	const task = ruleset.nodeTypes.find((type) => type.key === 'task')!;
	task.fields = [...(task.fields ?? []), multiple, plain];
	task.summaryFields = [...(task.summaryFields ?? []), 'accounts', 'notes'];

	const flow = ruleset.edgeTypes!.find((type) => type.key === 'flow')!;
	flow.fields = [...(flow.fields ?? []), { ...dropdown }];
	flow.labelTemplate = '{{label}} {{customer}}';
});

/* Recognising references ------------------------------------------------------- */

describe('asReference', () => {
	test('by shape: exactly a key (text or number) and a collection, for any field', () => {
		expect(asReference({ key: 3, collection: 'customers' })).toEqual(ref(3));
		expect(asReference({ collection: 'customers', key: 'abc' })).toEqual(ref('abc'));
		expect(asReference({ key: 3, collection: 'customers' }, plain)).toEqual(ref(3));

		// Other objects are not references.
		expect(asReference({ key: 3, collection: 'customers', label: 'x' })).toBeNull();
		expect(asReference({ key: 3 })).toBeNull();
		expect(asReference({ key: '', collection: 'customers' })).toBeNull();
		expect(asReference({ key: Number.NaN, collection: 'customers' })).toBeNull();
		expect(asReference({ key: null, collection: 'customers' })).toBeNull();
		expect(asReference({ key: { id: 1 }, collection: 'customers' })).toBeNull();
		expect(asReference({ key: 3, collection: '' })).toBeNull();
		expect(asReference([{ key: 3, collection: 'customers' }])).toBeNull();
		expect(asReference('3', dropdown)).toBeNull();
		expect(asReference(3, dropdown)).toBeNull();
	});

	test('by interface: other keys are allowed and a missing collection comes from selectedCollection', () => {
		expect(isReferenceField(dropdown)).toBe(true);
		expect(isReferenceField(multiple)).toBe(true);
		expect(isReferenceField(plain)).toBe(false);
		expect(isReferenceField(undefined)).toBe(false);

		expect(asReference({ key: 3, collection: 'customers', extra: true }, dropdown)).toEqual(ref(3));
		expect(asReference({ key: 3 }, dropdown)).toEqual(ref(3));
		expect(asReference({ key: 3, collection: 'others' }, dropdown)).toEqual(ref(3, 'others'));
		expect(asReference({ key: 3 }, { ...dropdown, meta: { interface: 'collection-item-dropdown' } })).toBeNull();
	});
});

/* Rendering --------------------------------------------------------------------- */

describe('formatValue and renderTemplate with references', () => {
	test('a reference shows the resolver label, or its key without one', () => {
		const { resolve } = resolver();

		expect(formatValue({ key: 1, collection: 'customers' }, dropdown, true, resolve)).toBe('ssh-adserver');
		expect(formatValue({ key: 1, collection: 'customers' }, dropdown)).toBe('1');
		expect(formatValue({ key: 'a-b', collection: 'customers' })).toBe('a-b');
	});

	test('falls back to the key when the resolver does not know the item, returns empty text or throws', () => {
		expect(formatValue(ref(99), dropdown, true, resolver().resolve)).toBe('99');
		expect(formatValue(ref(1), dropdown, true, () => '')).toBe('1');
		expect(
			formatValue(ref(1), dropdown, true, () => {
				throw new Error('app bug');
			}),
		).toBe('1');
	});

	test('lists of references are joined with ", ", known and unknown alike', () => {
		const value = [ref(1), ref(2), ref(5)];
		expect(formatValue(value, multiple, true, resolver().resolve)).toBe('ssh-adserver, Northwind, 5');
		expect(formatValue(value, multiple)).toBe('1, 2, 5');
	});

	test('other objects still render empty, with or without a resolver', () => {
		const { resolve, calls } = resolver();

		expect(formatValue({ name: 'x' }, plain, true, resolve)).toBe('');
		expect(formatValue({ key: 1, collection: 'customers', more: 1 }, plain, true, resolve)).toBe('');
		expect(renderTemplate('[{{nested}}]', { nested: { deep: { value: 7 } } }, null, resolve)).toBe('[]');
		expect(calls).toEqual([]);
	});

	test('{{customer}} shows the name, {{customer.key}} and {{customer.collection}} stay plain paths', () => {
		const { resolve, calls } = resolver();
		const scope = { customer: { key: 1, collection: 'customers' } };

		expect(renderTemplate('{{customer}}', scope, [dropdown], resolve)).toBe('ssh-adserver');
		expect(renderTemplate('{{ customer.key }} in {{customer.collection}}', scope, [dropdown], resolve)).toBe('1 in customers');
		expect(renderTemplate('{{customer}}', scope, [dropdown])).toBe('1');
		expect(renderTemplate('{{customer}}', scope)).toBe('1');

		// The resolver gets the field, so it can use the field's own template.
		expect(calls).toEqual([{ reference: ref(1), field: 'customer' }]);
	});

	test('a reference nested in other data is found by shape through a path', () => {
		const { resolve, calls } = resolver();
		const scope = { notes: { region: { key: 7, collection: 'regions' } } };

		expect(renderTemplate('{{notes.region}}', scope, [plain], resolve)).toBe('North');
		expect(calls[0]?.field).toBe('notes');
	});

	test('templatePaths lists the valid paths once', () => {
		expect(templatePaths('{{ name }} ({{region.name}}) {{name}} {{ not valid }} {{$thumbnail}}')).toEqual(['name', 'region.name', '$thumbnail']);
		expect(templatePaths(null)).toEqual([]);
	});
});

describe('nodeTitle, nodeSummary and edgeLabel with references', () => {
	const start = node('s', 'start', { customer: { key: 1, collection: 'customers' } });

	test('titles show the name, the key without a resolver, and the type label without a customer', () => {
		expect(nodeTitle(withReferences, start, resolver().resolve)).toBe('Start for ssh-adserver');
		expect(nodeTitle(withReferences, start)).toBe('Start for 1');
		expect(nodeTitle(withReferences, node('s', 'start', {}), resolver().resolve)).toBe('Start');
	});

	test('summary rows now include reference fields (they used to be left out as empty)', () => {
		const { resolve } = resolver();

		expect(nodeSummary(withReferences, start, resolve)).toEqual([{ label: 'Customer', value: 'ssh-adserver' }]);
		expect(nodeSummary(withReferences, start)).toEqual([{ label: 'Customer', value: '1' }]);

		const task = node('t', 'task', { title: 'Review', accounts: [ref(1), ref(2)], notes: { key: 'x', collection: 'customers', other: 1 } });
		expect(nodeSummary(withReferences, task, resolve)).toEqual([{ label: 'Accounts', value: 'ssh-adserver, Northwind' }]);
		expect(nodeSummary(withReferences, task)).toEqual([{ label: 'Accounts', value: '1, 2' }]);
	});

	test('edge labels show the name, or the key', () => {
		const flow = edge('e', 's.next', 't.in', 'flow', { customer: { key: 2, collection: 'customers' } });

		expect(edgeLabel(withReferences, flow, resolver().resolve)).toBe('Northwind');
		expect(edgeLabel(withReferences, flow)).toBe('2');
		expect(edgeLabel(withReferences, edge('e', 's.next', 't.in', 'flow', { label: 'yes' }), resolver().resolve)).toBe('yes');
	});

	test('nothing changes for values that are not references', () => {
		const workflow = validWorkflow();
		const { resolve, calls } = resolver();

		for (const item of workflow.nodes) {
			expect(nodeTitle(withReferences, item, resolve)).toBe(nodeTitle(withReferences, item));
			expect(nodeSummary(withReferences, item, resolve)).toEqual(nodeSummary(withReferences, item));
		}

		for (const item of workflow.edges) expect(edgeLabel(withReferences, item, resolve)).toBe(edgeLabel(withReferences, item));
		expect(calls).toEqual([]);
	});
});

/* Messages ---------------------------------------------------------------------- */

describe('issue messages', () => {
	// A Start whose output is unconnected: min_connections names the node by its title.
	const document = doc([node('s', 'start', { customer: { key: 1, collection: 'customers' } })]);

	test('name the node by key without a resolver and by name with one; fingerprints do not change', () => {
		const plainIssues = validateDocument(withReferences, document);
		const named = validateDocument(withReferences, document, { references: resolver().resolve });

		expect(plainIssues.some((issue) => issue.message.startsWith('"Start for 1"'))).toBe(true);
		expect(named.some((issue) => issue.message.startsWith('"Start for ssh-adserver"'))).toBe(true);
		expect(named.map((issue) => issue.fingerprint)).toEqual(plainIssues.map((issue) => issue.fingerprint));
		expect(validateValue(withReferences, document).issues.map((issue) => issue.message)).toEqual(plainIssues.map((issue) => issue.message));
	});

	test('canConnect passes the resolver on to the node names of its refusals', () => {
		const pair = doc([node('s', 'start', { customer: ref(1) }), node('t', 'task')]);
		const result = canConnect(withReferences, pair, { source: 's', sourceHandle: 'gone', target: 't', targetHandle: 'in' }, { references: resolver().resolve });
		expect(result).toMatchObject({ ok: false, code: 'unknown_port', message: '"Start for ssh-adserver" has no output "gone".' });
	});

	test('the hook still validates and names nodes by key, with no resolver', async () => {
		const ruleset = JSON.parse(JSON.stringify(exampleRuleset)) as Ruleset;
		const start = ruleset.nodeTypes.find((type) => type.key === 'start')!;
		start.fields = [...(start.fields ?? []), { ...dropdown, meta: { ...dropdown.meta, required: true } }];
		start.titleTemplate = 'Start for {{customer}}';

		const { create } = guardSetup({ ruleset, enforcement: 'reject' });
		const graph = doc([node('s', 'start', { customer: ref(3) }), node('e', 'end', { outcome: 'approved' })], [edge('x', 's.next', 'e.in', 'flow')]);

		const error = await create({ graph }).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ extensions: { issues: [{ code: 'pair_not_allowed' }] } });
		expect((error as { extensions: { validation_message: string } }).extensions.validation_message).toContain('"Start for 3" → "End: Approved"');

		const accepted = await create({ graph: doc([node('s', 'start', { customer: ref(3) })]) });
		expect(accepted.graph.meta.errorCount).toBe(0);
	});
});

/* Collecting -------------------------------------------------------------------- */

describe('collectReferences and documentReferences', () => {
	test('declared fields carry their field; lists share it; nested references are found by shape without one', () => {
		const data = {
			customer: { key: 1, collection: 'customers' },
			accounts: [ref(1), ref(2), 'junk'],
			notes: { region: { key: 7, collection: 'regions' }, list: [{ deeper: ref(9, 'deep') }] },
			loose: { key: 4 },
		};

		const found = collectReferences(data, [dropdown, multiple, plain]);

		expect(found.map(({ reference, field }) => [reference.collection, reference.key, field?.field])).toEqual([
			['customers', 1, 'customer'],
			['customers', 1, 'accounts'],
			['customers', 2, 'accounts'],
			['regions', 7, undefined],
			['deep', 9, undefined],
		]);
	});

	test('a document yields the references of every node and edge, unknown types included', () => {
		const document = doc(
			[node('s', 'start', { customer: { key: 1 } }), node('g', 'retired', { who: ref(5, 'users') })],
			[edge('e', 's.next', 'g.in', 'flow', { customer: ref(2) })],
		);

		expect(documentReferences(withReferences, document).map(({ reference, field }) => `${reference.collection}:${reference.key}:${field?.field ?? '-'}`)).toEqual([
			'customers:1:customer',
			'users:5:-',
			'customers:2:customer',
		]);

		expect(documentReferences(withReferences, null)).toEqual([]);
		expect(collectReferences('not data')).toEqual([]);
	});
});

/* What the editor asks the API for ----------------------------------------------- */

/** A schema like the app's stores: customers (display template {{name}}) → regions, and a user without some rights. */
function schema(overrides: Partial<ReferenceSchema> = {}): ReferenceSchema {
	const fields: Record<string, string[]> = {
		customers: ['id', 'name', 'code', 'region', 'meta', 'secret'],
		regions: ['id', 'name'],
		directus_users: ['id', 'first_name', 'last_name'],
	};

	return {
		hasCollection: (collection) => collection in fields,
		primaryKey: (collection) => (collection in fields ? 'id' : null),
		displayTemplate: (collection) => (collection === 'customers' ? '{{name}}' : collection === 'directus_users' ? '{{first_name}} {{last_name}}' : null),
		hasField: (collection, field) => fields[collection]?.includes(field) ?? false,
		relatedCollection: (collection, field) => (collection === 'customers' && field === 'region' ? 'regions' : null),
		canRead: () => true,
		...overrides,
	};
}

describe('reference-query', () => {
	test('endpoints follow getEndpoint: system collections have their own routes', () => {
		expect(referenceEndpoint('customers')).toBe('/items/customers');
		expect(referenceEndpoint('directus_users')).toBe('/users');
		expect(referenceEndpoint('directus_files')).toBe('/files');
	});

	test('template: the field option, then the collection display template, then the primary key', () => {
		expect(referenceTemplate(schema(), 'customers', multiple)).toBe('{{code}}');
		expect(referenceTemplate(schema(), 'customers', dropdown)).toBe('{{name}}');
		expect(referenceTemplate(schema(), 'customers')).toBe('{{name}}');
		expect(referenceTemplate(schema(), 'regions', dropdown)).toBe('{{id}}');
		expect(referenceTemplate(schema(), 'nowhere')).toBe('');

		// The option counts only for the reference interfaces, and only for the collection the field picks from.
		expect(referenceTemplate(schema(), 'customers', { ...plain, meta: { interface: 'list', options: { template: '{{label}}' } } })).toBe('{{name}}');
		expect(referenceTemplate(schema(), 'regions', multiple)).toBe('{{id}}');
	});

	test('plans one request with the primary key and only the fields the templates need', () => {
		const plan = planReferenceRequest(schema(), 'customers', ['{{name}}', '{{code}} · {{region.name}}', '{{meta.label}}', '{{nope}} {{region.nope}}']);

		expect(plan).toEqual({ kind: 'fetch', endpoint: '/items/customers', primaryKey: 'id', fields: ['id', 'name', 'code', 'region.name', 'meta', 'region'] });
		expect(referenceQuery(plan as Extract<typeof plan, { kind: 'fetch' }>, [1, '2'])).toEqual({
			fields: 'id,name,code,region.name,meta,region',
			filter: '{"id":{"_in":[1,"2"]}}',
			limit: -1,
		});
	});

	test('asks for nothing it may not read, and nothing at all when only keys would show', () => {
		const restricted = schema({
			canRead: (collection, field) => collection === 'customers' && field !== 'secret',
		});

		expect(planReferenceRequest(restricted, 'customers', ['{{name}} {{secret}} {{region.name}}'])).toMatchObject({ fields: ['id', 'name', 'region'] });
		expect(planReferenceRequest(restricted, 'regions', ['{{name}}'])).toEqual({ kind: 'unreadable' });
		expect(planReferenceRequest(schema(), 'nowhere', ['{{name}}'])).toEqual({ kind: 'unreadable' });
		expect(planReferenceRequest(restricted, 'customers', ['{{id}}', '{{secret}}'])).toEqual({ kind: 'keys' });
	});

	test('labels are the template rendered as plain text, undefined when empty', () => {
		expect(referenceLabel('{{code}} · {{region.name}}', { id: 1, code: 'C-1', region: { name: 'North' } })).toBe('C-1 · North');
		expect(referenceLabel('{{name}}', { id: 1, name: '<b>x</b>\u0000' })).toBe('<b>x</b>');
		expect(referenceLabel('{{name}}', { id: 1, name: '  ' })).toBeUndefined();
		expect(referenceLabel('{{name}}', null)).toBeUndefined();
		expect(labelKey('customers', '{{name}}', 1)).toBe(labelKey('customers', '{{name}}', '1'));
	});
});
