import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compileRuleset, exampleRuleset } from '../src/shared/core';
import { RULESET_TEMPLATE, nodeGraphOptions, resolveFieldOptions } from '../src/shared/options';

describe('nodeGraphOptions', () => {
	test('declares the documented options, in order', () => {
		expect(nodeGraphOptions.map((option) => option.field)).toEqual([
			'ruleset',
			'template',
			'placeholder',
			'editorWidth',
			'enforcement',
			'snapToGrid',
			'gridSize',
			'showMinimap',
		]);
	});

	test('the ruleset option is a json field edited with input-code, with the example as its template', () => {
		const ruleset = nodeGraphOptions[0]!;

		expect(ruleset.type).toBe('json');
		expect(ruleset.meta?.interface).toBe('input-code');
		expect(ruleset.meta?.width).toBe('full');

		// input-code emits JSON.parse(template) for json fields, so the template must parse and compile.
		const template = ruleset.meta?.options?.['template'] as string;
		expect(template).toBe(RULESET_TEMPLATE);
		expect(compileRuleset(JSON.parse(template)).problems).toEqual([]);
	});

	test('defaults match resolveFieldOptions', () => {
		const defaults = Object.fromEntries(nodeGraphOptions.filter((option) => option.schema).map((option) => [option.field, option.schema!.default_value]));
		const resolved = resolveFieldOptions({});

		for (const [key, value] of Object.entries(defaults)) {
			expect(resolved[key as keyof typeof resolved]).toEqual(value);
		}
	});

	test('examples/approval-workflow.json is the example ruleset, as the template writes it', () => {
		const file = readFileSync(new URL('../examples/approval-workflow.json', import.meta.url), 'utf8');
		expect(file).toBe(`${RULESET_TEMPLATE}\n`);
		expect(JSON.parse(file)).toEqual(JSON.parse(JSON.stringify(exampleRuleset)));
	});
});

describe('examples', () => {
	const directory = new URL('../examples/', import.meta.url);
	const files = readdirSync(directory).filter((name) => name.endsWith('.json'));

	test('the examples directory has rulesets', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	test.each(files)('%s compiles without problems', (name) => {
		const result = compileRuleset(readFileSync(new URL(name, directory), 'utf8'));
		expect(result.problems).toEqual([]);
		expect(result.ruleset).not.toBeNull();
	});
});

describe('resolveFieldOptions', () => {
	test('fills defaults for missing options', () => {
		expect(resolveFieldOptions(undefined)).toEqual({
			ruleset: null,
			template: null,
			placeholder: null,
			editorWidth: 'wide',
			enforcement: 'ratchet',
			snapToGrid: true,
			gridSize: 18,
			showMinimap: false,
		});
	});

	test('keeps valid values and replaces invalid ones', () => {
		expect(
			resolveFieldOptions({
				ruleset: '{"key":"x"}',
				template: '{{nodeCount}}',
				placeholder: 'No workflow yet',
				editorWidth: 'full',
				enforcement: 'log',
				snapToGrid: false,
				gridSize: 24.4,
				showMinimap: true,
			}),
		).toEqual({
			ruleset: '{"key":"x"}',
			template: '{{nodeCount}}',
			placeholder: 'No workflow yet',
			editorWidth: 'full',
			enforcement: 'log',
			snapToGrid: false,
			gridSize: 24,
			showMinimap: true,
		});

		expect(resolveFieldOptions({ editorWidth: 'huge', enforcement: 'maybe', gridSize: 9999, ruleset: 5, template: '  ' })).toMatchObject({
			editorWidth: 'wide',
			enforcement: 'ratchet',
			gridSize: 96,
			ruleset: null,
			template: null,
		});
	});
});
