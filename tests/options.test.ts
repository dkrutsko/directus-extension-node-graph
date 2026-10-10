import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compileRuleset, exampleRuleset } from '../src/shared/core';
import { RULESET_TEMPLATE, generalOptionFields, resolveFieldOptions } from '../src/shared/options';

describe('generalOptionFields', () => {
	test('declares the documented plain options, in order (the ruleset has its own form)', () => {
		expect(generalOptionFields.map((option) => option.field)).toEqual([
			'template',
			'placeholder',
			'editorWidth',
			'enforcement',
			'snapToGrid',
			'gridSize',
			'showMinimap',
		]);
	});

	test('the example template parses and compiles', () => {
		expect(compileRuleset(JSON.parse(RULESET_TEMPLATE)).problems).toEqual([]);
	});

	test('defaults match resolveFieldOptions', () => {
		const defaults = Object.fromEntries(generalOptionFields.filter((option) => option.schema).map((option) => [option.field, option.schema!.default_value]));
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
