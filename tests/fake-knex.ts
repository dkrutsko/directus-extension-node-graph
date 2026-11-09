/**
 * Just enough of knex for the guard: select(...).from(...).where(...)
 * .whereIn(...).first(), awaited. Counts queries per table, can fail every
 * query, and can hold queries until released (to model SQLite's single
 * pooled connection being busy). Plus just enough of Directus's services for
 * the guard: an ItemsService whose readMany reads through the knex it was
 * built with and applies a per-test read rule the way the permission pipeline
 * would.
 */

import { ForbiddenError } from '@directus/errors';
import type { Accountability, PrimaryKey, SchemaOverview } from '@directus/types';
import type { Knex } from 'knex';
import type { GuardServices } from '../src/shared/hook/guard';

export type Row = Record<string, unknown>;

/**
 * How a non-admin accountability sees one stored row: the row (with the
 * fields it may read; leave one out to model a field hidden by `cases`), or
 * null when the policies' item filters hide it. With no rule at all, every
 * read by a non-admin throws ForbiddenError, as processAst does for a caller
 * without read permission on the collection or a requested field.
 */
export type ReadRule = (accountability: Accountability, row: Row) => Row | null;

export interface ReadCall {
	collection: string;
	keys: PrimaryKey[];
	fields: string[];
	limit: number | undefined;
	emitEvents: boolean | undefined;
	accountability: Accountability | null | undefined;
	knex: Knex | undefined;
}

export function fakeServices() {
	const calls: ReadCall[] = [];
	const access: { rule: ReadRule | null } = { rule: null };

	class ItemsService {
		constructor(
			private collection: string,
			private options: { knex?: Knex; schema: SchemaOverview; accountability?: Accountability | null },
		) {}

		async readMany(keys: PrimaryKey[], query: { fields?: string[]; limit?: number } = {}, opts: { emitEvents?: boolean } = {}): Promise<Row[]> {
			const { knex, schema, accountability } = this.options;
			calls.push({ collection: this.collection, keys, fields: query.fields ?? [], limit: query.limit, emitEvents: opts.emitEvents, accountability, knex });

			if (!knex) throw new Error('fake ItemsService: no knex given');
			const primary = schema.collections[this.collection]?.primary;
			if (!primary) throw new Error(`fake ItemsService: no schema for ${this.collection}`);

			// The real service queries through its own knex (api/src/services/items.ts:52-61), which is what the SQLite deadlock test relies on.
			const rows: Row[] = await knex.select(query.fields ?? []).from(this.collection).whereIn(primary, keys);

			if (!accountability || accountability.admin) return rows;
			if (!access.rule) throw new ForbiddenError();

			const rule = access.rule;
			return rows.map((row) => rule(accountability, row)).filter((row): row is Row => row !== null);
		}
	}

	return { services: { ItemsService } as unknown as GuardServices, calls, access };
}

export function fakeDatabase(tables: Record<string, Row[]>) {
	const queries: string[] = [];
	const held: Array<() => void> = [];
	let failing = false;
	let holding = false;

	const database = {
		select(...columns: Array<string | string[]>) {
			const wanted = columns.flat();
			const filters: Array<(row: Row) => boolean> = [];
			let table = '';
			let firstOnly = false;

			const builder = {
				from(name: string) {
					table = name;
					queries.push(name);
					return builder;
				},
				where(column: string | Row, value?: unknown) {
					if (typeof column === 'string') filters.push((row) => row[column] === value);
					else filters.push((row) => Object.entries(column).every(([key, expected]) => row[key] === expected));
					return builder;
				},
				whereIn(column: string, values: unknown[]) {
					const set = new Set(values.map(String));
					filters.push((row) => set.has(String(row[column])));
					return builder;
				},
				first() {
					firstOnly = true;
					return builder;
				},
				then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
					const run = () => {
						if (failing) return reject(new Error('database is down'));

						const rows = (tables[table] ?? [])
							.filter((row) => filters.every((filter) => filter(row)))
							.map((row) => Object.fromEntries(wanted.map((key) => [key, row[key]])));

						resolve(firstOnly ? rows[0] : rows);
					};

					if (holding) held.push(run);
					else run();
				},
			};

			return builder;
		},
	};

	return {
		database: database as unknown as Knex,
		queries,
		fail: () => {
			failing = true;
		},
		/** Queries wait from now on until release(). */
		hold: () => {
			holding = true;
		},
		release: () => {
			holding = false;
			for (const run of held.splice(0)) run();
		},
	};
}
