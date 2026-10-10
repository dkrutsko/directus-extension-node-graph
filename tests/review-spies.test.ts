/**
 * Regression tests from the review of the core and the hook (see
 * review.test.ts) that count calls into core: they wrap core modules with
 * vi.mock, which applies to the whole file, so they live apart from
 * review.test.ts.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { computeMeta, fieldSummary } from '../src/shared/core';
import { graphHash } from '../src/shared/core/hash';
import { validateDocument, validateValue } from '../src/shared/core/validate';
import { guardSetup } from './guard-setup';
import { doc, example, node, validWorkflow } from './helpers';

vi.mock('../src/shared/core/hash', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/shared/core/hash')>();
	return { ...actual, graphHash: vi.fn(actual.graphHash) };
});

vi.mock('../src/shared/core/validate', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/shared/core/validate')>();
	return { ...actual, validateDocument: vi.fn(actual.validateDocument), validateValue: vi.fn(actual.validateValue) };
});

beforeEach(() => {
	vi.mocked(graphHash).mockClear();
	vi.mocked(validateDocument).mockClear();
	vi.mocked(validateValue).mockClear();
});

describe('ratchet validates each distinct stored value once', () => {
	test('a bulk update over 1,500 items holding two different graphs validates three values', async () => {
		// One graph with a pre-existing error (a task without a title), stored as text (SQLite), and one
		// with two such errors, stored as an object (Postgres).
		const broken = doc([...validWorkflow().nodes, node('t9', 'task', {})], validWorkflow().edges);
		const other = doc([...validWorkflow().nodes, node('t9', 'task', {}), node('t10', 'task', {})], validWorkflow().edges);

		const items = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, graph: i % 2 ? JSON.stringify(broken) : other }));
		const { update } = guardSetup({}, [], items);

		const result = await update({ graph: broken }, items.map((item) => item.id));

		expect(result.graph.meta.errorCount).toBe(1);
		// The incoming value, then each distinct stored value once.
		expect(validateValue).toHaveBeenCalledTimes(3);
	});
});

describe('fieldSummary does only the work its text needs', () => {
	test('the default text neither hashes nor validates', () => {
		expect(fieldSummary({}, example, validWorkflow())).toBe('7 nodes · 9 connections');
		expect(graphHash).not.toHaveBeenCalled();
		expect(validateDocument).not.toHaveBeenCalled();
	});

	test('a template validates (for its issue counts) but never hashes', () => {
		expect(fieldSummary({ template: '{{nodeCount}} / {{errorCount}} errors / {{counts.end}} ends' }, example, validWorkflow())).toBe('7 / 0 errors / 2 ends');
		expect(validateDocument).toHaveBeenCalledTimes(1);
		expect(graphHash).not.toHaveBeenCalled();

		// computeMeta, which is stored, still carries the hash.
		expect(computeMeta(example, validWorkflow(), []).graphHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(graphHash).toHaveBeenCalledTimes(1);
	});
});
