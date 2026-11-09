import { isDirectusError } from '@directus/errors';
import type { Accountability, HookConfig } from '@directus/types';
import { describe, expect, test, vi } from 'vitest';
import { exampleRuleset, graphHash, starterDocument } from '../src/shared/core';
import type { GraphDocument } from '../src/shared/core';
import { createGuard } from '../src/shared/hook/guard';
import { fakeDatabase, fakeServices, type Row } from './fake-knex';
import { admin, user } from './guard-setup';
import { doc, edge, example, node, validWorkflow } from './helpers';

type Handler = (...args: any[]) => any;

/** A ruleset that does not compile. */
const brokenRuleset = { key: 'x', nodeTypes: [] };

function setup(options: Record<string, unknown> = {}, items: Row[] = []) {
	const fields: Row[] = [
		{ id: 1, collection: 'graph_test', field: 'graph', interface: 'node-graph-test', options: JSON.stringify({ ruleset: exampleRuleset, ...options }) },
		{ id: 2, collection: 'graph_test', field: 'title', interface: 'input', options: null },
		{ id: 3, collection: 'other', field: 'graph', interface: 'node-graph-someone-else', options: '{}' },
		// Fields on another interface that still hold a ruleset from an earlier life (F-06).
		{ id: 4, collection: 'graph_test', field: 'legacy', interface: 'input-code', options: JSON.stringify({ ruleset: brokenRuleset }) },
		{ id: 5, collection: 'graph_test', field: 'legacy_ok', interface: 'input-code', options: { ruleset: exampleRuleset } },
	];

	const db = fakeDatabase({ directus_fields: fields, graph_test: items });
	const { services, calls, access } = fakeServices();
	const filters = new Map<string, Handler>();
	const actions = new Map<string, Handler[]>();
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

	const guard: HookConfig = createGuard('node-graph-test');

	guard(
		{
			filter: (event: string, handler: Handler) => filters.set(event, handler),
			action: (event: string, handler: Handler) => actions.set(event, [...(actions.get(event) ?? []), handler]),
			init: () => undefined,
			schedule: () => undefined,
			embed: () => undefined,
		} as never,
		{ database: db.database, logger, services, env: {}, getSchema: async () => ({}), emitter: null } as never,
	);

	const contextAs = (accountability: Accountability | null) => ({
		database: db.database,
		schema: { collections: { graph_test: { collection: 'graph_test', primary: 'id', fields: {} } } },
		accountability,
	});

	const context = contextAs(admin);

	const create = (payload: unknown) => filters.get('items.create')!(payload, { event: 'items.create', collection: 'graph_test' }, context);
	const update = (payload: unknown, keys: unknown[] = [1]) => filters.get('items.update')!(payload, { event: 'items.update', collection: 'graph_test', keys }, context);
	const updateAs = (accountability: Accountability | null, payload: unknown, keys: unknown[] = [1]) =>
		filters.get('items.update')!(payload, { event: 'items.update', collection: 'graph_test', keys }, contextAs(accountability));

	return { filters, actions, logger, db, context, contextAs, create, update, updateAs, fields, calls, access };
}

/** Runs a promise that should reject and returns the rejection. */
async function rejectionOf(promise: Promise<unknown>): Promise<any> {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	throw new Error('expected a rejection');
}

/** The valid workflow plus an unconnected task without a title: one error (field_required), two warnings. */
const brokenTask = () => doc([...validWorkflow().nodes, node('t9', 'task', {})], validWorkflow().edges);

describe('createGuard: items', () => {
	test('registers the item and field filters and the field actions', () => {
		const { filters, actions } = setup();
		expect([...filters.keys()].sort()).toEqual(['fields.create', 'fields.update', 'items.create', 'items.update']);
		expect([...actions.keys()].sort()).toEqual(['fields.create', 'fields.delete', 'fields.update']);
	});

	test('leaves unmanaged collections, fields and payloads alone', async () => {
		const { filters, context } = setup();
		const payload = { title: 'x', graph: 'not even a graph' };

		expect(await filters.get('items.create')!(payload, { collection: 'other' }, context)).toBe(payload);
		expect(await filters.get('items.create')!({ title: 'only title' }, { collection: 'graph_test' }, context)).toEqual({ title: 'only title' });
		expect(await filters.get('items.create')!('string payload', { collection: 'graph_test' }, context)).toBe('string payload');
	});

	test('accepts a valid graph and writes back normalised value, meta and stamp', async () => {
		const { create } = setup();
		const value = { ...validWorkflow(), _user: 'u1', meta: { nodeCount: 999, edgeCount: 0, errorCount: 0, warningCount: 0, counts: {}, graphHash: 'forged' } };

		const result = await create({ title: 'ok', graph: value });
		const graph = result.graph as GraphDocument;

		expect(result.title).toBe('ok');
		expect(graph).not.toHaveProperty('_user');
		expect(graph.ruleset).toEqual({ key: 'approval-workflow', version: 1 });
		expect(graph.meta).toEqual({
			nodeCount: 7,
			edgeCount: 9,
			errorCount: 0,
			warningCount: 0,
			counts: { approval: 1, condition: 1, end: 2, notify: 1, start: 1, task: 1 },
			graphHash: graphHash(validWorkflow()),
		});
	});

	test('accepts the starter graph (warnings only) and null', async () => {
		const { create } = setup();
		expect((await create({ graph: starterDocument(example) })).graph.meta.warningCount).toBe(3);
		expect(await create({ graph: null })).toEqual({ graph: null });
	});

	test('accepts JSON strings and writes back an object', async () => {
		const { create } = setup();
		const result = await create({ graph: JSON.stringify(validWorkflow()) });
		expect(typeof result.graph).toBe('object');
		expect(result.graph.nodes).toHaveLength(7);
	});

	test('ratchet on create rejects any error with a FAILED_VALIDATION the app shows under the field', async () => {
		const { create } = setup();
		const error = await rejectionOf(create({ graph: brokenTask() }));

		expect(isDirectusError(error, 'FAILED_VALIDATION')).toBe(true);
		expect(error.status).toBe(400);
		expect(error.extensions).toEqual({
			collection: 'graph_test',
			field: 'graph',
			path: [],
			type: 'regex',
			validation_message: 'The graph has 1 error: "Task": "Title" is required. [field_required, node t9]',
			issues: [{ code: 'field_required', nodeId: 't9', field: 'title' }],
		});

		expect(error.message).toBe('Validation failed for field "graph". The graph has 1 error: "Task": "Title" is required. [field_required, node t9]');
	});

	test('ratchet on update rejects only errors the stored graph did not have', async () => {
		const stored = brokenTask();
		const { update } = setup({}, [{ id: 1, graph: JSON.stringify(stored) }]);

		// Same pre-existing error, other changes: accepted.
		const moved = { ...stored, nodes: stored.nodes.map((item) => ({ ...item, position: { x: 0, y: 0 } })) };
		const result = await update({ graph: moved });
		expect(result.graph.meta.errorCount).toBe(1);

		// A new error on top: rejected, naming only the new one.
		const worse = { ...stored, edges: [...stored.edges, edge('loop', 'n.next', 'n.in', 'flow')] };
		const error = await rejectionOf(update({ graph: worse }));

		expect(error.extensions.issues.map((issue: { code: string }) => issue.code)).toEqual(['self_loop', 'max_connections']);
		expect(error.extensions.validation_message).toMatch(/^This change adds 2 errors to the graph: /);
	});

	test('ratchet behaves like reject when the stored value is null or the row is missing', async () => {
		const { update } = setup({}, [{ id: 1, graph: null }]);

		expect(isDirectusError(await rejectionOf(update({ graph: brokenTask() }, [1])))).toBe(true);
		expect(isDirectusError(await rejectionOf(update({ graph: brokenTask() }, [404])))).toBe(true);
	});

	test('ratchet across several updated items requires every item to already have the error', async () => {
		const { update } = setup({}, [
			{ id: 1, graph: JSON.stringify(brokenTask()) },
			{ id: 2, graph: JSON.stringify(validWorkflow()) },
		]);

		expect(isDirectusError(await rejectionOf(update({ graph: brokenTask() }, [1, 2])))).toBe(true);
		expect((await update({ graph: brokenTask() }, ['1'])).graph.meta.errorCount).toBe(1);
	});

	test('ratchet reads the stored graphs through ItemsService on the event handle, as the caller, without events', async () => {
		const { update, updateAs, calls, db, access } = setup({}, [{ id: 1, graph: JSON.stringify(brokenTask()) }]);
		access.rule = (_accountability, row) => row;

		await update({ graph: brokenTask() });
		await updateAs(user, { graph: brokenTask() }, ['1']);
		await updateAs(null, { graph: brokenTask() });

		expect(calls).toHaveLength(3);
		expect(calls.map((call) => call.accountability)).toEqual([admin, user, null]);

		for (const call of calls) {
			expect(call).toMatchObject({ collection: 'graph_test', fields: ['id', 'graph'], emitEvents: false, limit: call.keys.length });
			expect(call.knex).toBe(db.database);
		}

		// A create never reads stored values.
		const { create, calls: createCalls } = setup();
		await create({ graph: validWorkflow() });
		expect(createCalls).toHaveLength(0);
	});

	test('ratchet treats an item the caller may not read as a create: its old error now refuses, and nothing is logged as an error', async () => {
		const stored = brokenTask();
		const { updateAs, logger, access } = setup({}, [{ id: 1, graph: JSON.stringify(stored) }]);

		// No read permission at all: ItemsService throws ForbiddenError.
		const forbidden = await rejectionOf(updateAs(user, { graph: stored }));
		expect(isDirectusError(forbidden, 'FAILED_VALIDATION')).toBe(true);
		expect(forbidden.extensions.validation_message).toMatch(/^The graph has 1 error: /);
		expect(logger.error).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('may not read the stored graphs'));

		// Read permission with an item filter that hides this row: the row is absent.
		access.rule = (_accountability, row) => (row['id'] === 2 ? row : null);
		expect(isDirectusError(await rejectionOf(updateAs(user, { graph: stored })))).toBe(true);
		expect(logger.error).not.toHaveBeenCalled();

		// The same user may read the row: the old error is accepted again.
		access.rule = (_accountability, row) => row;
		expect((await updateAs(user, { graph: stored })).graph.meta.errorCount).toBe(1);

		// And a clean graph is accepted whatever the user may read.
		access.rule = null;
		expect((await updateAs(user, { graph: validWorkflow() })).graph.meta.errorCount).toBe(0);
	});

	test('ratchet treats a graph field the caller may not read as empty', async () => {
		const stored = brokenTask();
		const { updateAs, access } = setup({}, [{ id: 1, graph: JSON.stringify(stored) }]);

		// Readable row, but the graph field is not among the fields the user may read.
		access.rule = (_accountability, row) => ({ id: row['id'] });
		expect(isDirectusError(await rejectionOf(updateAs(user, { graph: stored })))).toBe(true);

		// Across several items, one unreadable item is enough: every item must already have the error.
		const { updateAs: updateTwo, access: accessTwo } = setup({}, [
			{ id: 1, graph: JSON.stringify(stored) },
			{ id: 2, graph: JSON.stringify(stored) },
		]);

		accessTwo.rule = (_accountability, row) => (row['id'] === 1 ? row : null);
		expect(isDirectusError(await rejectionOf(updateTwo(user, { graph: stored }, [1, 2])))).toBe(true);
		accessTwo.rule = (_accountability, row) => row;
		expect((await updateTwo(user, { graph: stored }, [1, 2])).graph.meta.errorCount).toBe(1);
	});

	test('ratchet still sees every stored graph for administrators and for writes without a user', async () => {
		const stored = brokenTask();
		const { update, updateAs, access, calls } = setup({}, [{ id: 1, graph: JSON.stringify(stored) }]);

		// A rule that would hide everything from a user does not apply to either.
		access.rule = () => null;
		expect((await update({ graph: stored })).graph.meta.errorCount).toBe(1);
		expect((await updateAs(null, { graph: stored })).graph.meta.errorCount).toBe(1);
		expect(calls.map((call) => call.accountability)).toEqual([admin, null]);
	});

	test('a stored read that fails for another reason is logged as an error and treated as empty', async () => {
		const stored = brokenTask();
		const { update, logger, db } = setup({}, [{ id: 1, graph: JSON.stringify(stored) }]);

		// The field map is loaded first; fail the database only afterwards.
		expect((await update({ graph: stored })).graph.meta.errorCount).toBe(1);
		db.fail();

		expect(isDirectusError(await rejectionOf(update({ graph: stored })))).toBe(true);
		expect(logger.error).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('could not read stored graphs of graph_test'));
	});

	test('reject blocks pre-existing errors too', async () => {
		const { update } = setup({ enforcement: 'reject' }, [{ id: 1, graph: JSON.stringify(brokenTask()) }]);
		expect(isDirectusError(await rejectionOf(update({ graph: brokenTask() })))).toBe(true);
	});

	test('log accepts and logs counts; off leaves the value untouched', async () => {
		const log = setup({ enforcement: 'log' });
		const result = await log.create({ graph: brokenTask() });

		expect(result.graph.meta.errorCount).toBe(1);
		expect(log.logger.info).toHaveBeenCalledWith(
			expect.objectContaining({ collection: 'graph_test', field: 'graph', errors: 1, warnings: 2 }),
			expect.stringContaining('enforcement: log'),
		);

		const off = setup({ enforcement: 'off' });
		const value = brokenTask();
		expect((await off.create({ graph: value })).graph).toBe(value);
	});

	test('rejects values that are not graphs, and keeps them untouched when the policy accepts them', async () => {
		const ratchet = setup();
		const error = await rejectionOf(ratchet.create({ graph: '{ not json' }));
		expect(error.extensions.issues).toEqual([{ code: 'invalid_document' }]);

		const polluted = JSON.parse(JSON.stringify(validWorkflow()).replace('"title":"Request received"', '"title":"Request received","__proto__":{"x":1}'));
		expect(isDirectusError(await rejectionOf(ratchet.create({ graph: polluted })))).toBe(true);

		const log = setup({ enforcement: 'log' });
		expect((await log.create({ graph: polluted })).graph).toBe(polluted);
	});

	test('a field with a broken ruleset still gets structural checks and a warning in the log', async () => {
		const { create, logger } = setup({ ruleset: { key: 'broken' } });
		const result = await create({ graph: validWorkflow() });

		expect(result.graph.meta.errorCount).toBe(0);
		expect(result.graph.ruleset).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('graph_test.graph has no valid ruleset'));
		expect(isDirectusError(await rejectionOf(create({ graph: 42 })))).toBe(true);
	});

	test('the field map is cached, cleared by fields.* actions, and a failing lookup never blocks writes', async () => {
		const { create, actions, db, logger } = setup();

		await create({ graph: validWorkflow() });
		await create({ graph: validWorkflow() });
		expect(db.queries.filter((table) => table === 'directus_fields')).toHaveLength(1);

		for (const handler of actions.get('fields.update')!) handler({}, {});
		await create({ graph: validWorkflow() });
		expect(db.queries.filter((table) => table === 'directus_fields')).toHaveLength(2);

		for (const handler of actions.get('fields.delete')!) handler({}, {});
		db.fail();
		const payload = { graph: 'anything' };
		expect(await create(payload)).toBe(payload);
		expect(logger.error).toHaveBeenCalled();
	});

	test('rejections for two graph fields are thrown together', async () => {
		const setupTwo = () => {
			const both = setup();
			both.fields.push({ collection: 'graph_test', field: 'graph2', interface: 'node-graph-test', options: JSON.stringify({ ruleset: exampleRuleset }) });
			return both;
		};

		const { create } = setupTwo();
		const error = await rejectionOf(create({ graph: brokenTask(), graph2: brokenTask() }));

		expect(Array.isArray(error)).toBe(true);
		expect(error.map((item: any) => item.extensions.field)).toEqual(['graph', 'graph2']);
	});
});

describe('createGuard: fields', () => {
	const fieldPayload = (ruleset: unknown, iface = 'node-graph-test') => ({ field: 'graph', type: 'json', meta: { interface: iface, options: { ruleset } } });

	test('rejects an invalid ruleset with InvalidPayloadError when saved by a user', async () => {
		const { filters, context } = setup();
		const error = await rejectionOf(filters.get('fields.create')!(fieldPayload({ key: 'x', nodeTypes: [] }), { collection: 'graph_test' }, context));

		expect(isDirectusError(error, 'INVALID_PAYLOAD')).toBe(true);
		expect(error.message).toBe('Invalid payload. The node graph ruleset of "graph" has 1 problem: nodeTypes: must declare at least one node type.');
	});

	test('accepts valid and missing rulesets, other interfaces, and anything without accountability', async () => {
		const { filters, context } = setup();
		const create = filters.get('fields.create')!;

		for (const payload of [fieldPayload(exampleRuleset), fieldPayload(JSON.stringify(exampleRuleset)), fieldPayload(null), fieldPayload({ broken: true }, 'input-code')]) {
			expect(await create(payload, { collection: 'graph_test' }, context)).toBe(payload);
		}

		const schemaApply = { ...context, accountability: null };
		const broken = fieldPayload({ broken: true });
		expect(await create(broken, { collection: 'graph_test' }, schemaApply)).toBe(broken);
	});

	test('an update carrying only options is checked against the stored interface', async () => {
		const { filters, context } = setup();
		const update = filters.get('fields.update')!;

		const optionsOnly = { field: 'graph', meta: { options: { ruleset: { key: 'x' } } } };
		expect(isDirectusError(await rejectionOf(update(optionsOnly, { collection: 'graph_test', keys: ['graph'] }, context)))).toBe(true);

		const otherField = { field: 'title', meta: { options: { ruleset: { key: 'x' } } } };
		expect(await update(otherField, { collection: 'graph_test', keys: ['title'] }, context)).toBe(otherField);
	});

	test('switching a field to the interface without sending options is checked against the options it already holds', async () => {
		const { filters, context, db } = setup();
		const update = filters.get('fields.update')!;

		const toOurs = { field: 'legacy', meta: { interface: 'node-graph-test' } };
		const error = await rejectionOf(update(toOurs, { collection: 'graph_test', keys: ['legacy'] }, context));

		expect(isDirectusError(error, 'INVALID_PAYLOAD')).toBe(true);
		expect(error.message).toBe('Invalid payload. The node graph ruleset of "legacy" has 1 problem: nodeTypes: must declare at least one node type.');
		expect(db.queries.filter((table) => table === 'directus_fields')).toHaveLength(1);

		// Sending valid options with the switch replaces the stored ones, so the stored ruleset is not consulted.
		const withOptions = { field: 'legacy', meta: { interface: 'node-graph-test', options: { ruleset: exampleRuleset } } };
		expect(await update(withOptions, { collection: 'graph_test', keys: ['legacy'] }, context)).toBe(withOptions);
		expect(db.queries.filter((table) => table === 'directus_fields')).toHaveLength(1);
	});

	test('switching is accepted when the stored ruleset compiles or is missing, on a create, and without accountability', async () => {
		const { filters, context, contextAs } = setup();
		const update = filters.get('fields.update')!;
		const create = filters.get('fields.create')!;

		const okStored = { field: 'legacy_ok', meta: { interface: 'node-graph-test' } };
		expect(await update(okStored, { collection: 'graph_test', keys: ['legacy_ok'] }, context)).toBe(okStored);

		const noOptions = { field: 'title', meta: { interface: 'node-graph-test' } };
		expect(await update(noOptions, { collection: 'graph_test', keys: ['title'] }, context)).toBe(noOptions);

		const unknownField = { field: 'brand_new', meta: { interface: 'node-graph-test' } };
		expect(await update(unknownField, { collection: 'graph_test', keys: ['brand_new'] }, context)).toBe(unknownField);

		const created = { field: 'fresh', type: 'json', meta: { interface: 'node-graph-test' } };
		expect(await create(created, { collection: 'graph_test' }, context)).toBe(created);

		const schemaApply = { field: 'legacy', meta: { interface: 'node-graph-test' } };
		expect(await update(schemaApply, { collection: 'graph_test', keys: ['legacy'] }, contextAs(null))).toBe(schemaApply);
	});

	test('a failing stored-options lookup lets the switch through and logs it', async () => {
		const { filters, context, db, logger } = setup();
		const payload = { field: 'legacy', meta: { interface: 'node-graph-test' } };

		db.fail();
		expect(await filters.get('fields.update')!(payload, { collection: 'graph_test', keys: ['legacy'] }, context)).toBe(payload);
		expect(logger.error).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('could not read the stored field graph_test.legacy'));
	});
});
