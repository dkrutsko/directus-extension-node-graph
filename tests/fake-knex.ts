/**
 * Just enough of knex for the guard: select(...).from(...).where(...)
 * .whereIn(...).first(), awaited. Counts queries per table, can fail every
 * query, and can hold queries until released (to model SQLite's single
 * pooled connection being busy).
 */

import type { Knex } from 'knex';

export type Row = Record<string, unknown>;

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
