/**
 * A guard registered against fake hook APIs and two fake knex handles: `root`
 * (the hook context's database, what an update's filter gets) and `trx` (what
 * a create's filter gets inside its transaction). Both read the same tables:
 * directus_fields with one graph field `graph_test.graph` using interface
 * `node-graph-test`, and `graph_test` with the given items.
 */

import type { HookConfig } from '@directus/types';
import { vi } from 'vitest';
import { exampleRuleset } from '../src/shared/core';
import { createGuard } from '../src/shared/hook/guard';
import { fakeDatabase, type Row } from './fake-knex';

type Handler = (...args: any[]) => any;

export function guardSetup(options: Record<string, unknown> = {}, extraFields: Row[] = [], items: Row[] = []) {
	const fields: Row[] = [
		{ id: 1, collection: 'graph_test', field: 'graph', interface: 'node-graph-test', options: JSON.stringify({ ruleset: exampleRuleset, ...options }) },
		{ id: 2, collection: 'graph_test', field: 'title', interface: 'input', options: null },
		...extraFields,
	];

	const tables = { directus_fields: fields, graph_test: items };
	const root = fakeDatabase(tables);
	const trx = fakeDatabase(tables);
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
		{ database: root.database, logger, services: {}, env: {}, getSchema: async () => ({}), emitter: null } as never,
	);

	const context = (db: ReturnType<typeof fakeDatabase>) => ({
		database: db.database,
		schema: { collections: { graph_test: { collection: 'graph_test', primary: 'id', fields: {} } } },
		accountability: { user: 'u1', role: null, admin: true, app: true },
	});

	const create = (payload: unknown, db = trx) => filters.get('items.create')!(payload, { event: 'items.create', collection: 'graph_test' }, context(db));
	const update = (payload: unknown, keys: unknown[] = [1], db = root) =>
		filters.get('items.update')!(payload, { event: 'items.update', collection: 'graph_test', keys }, context(db));
	const clear = () => actions.get('fields.update')!.forEach((handler) => handler({}, {}));

	return { fields, root, trx, filters, logger, context, create, update, clear };
}
