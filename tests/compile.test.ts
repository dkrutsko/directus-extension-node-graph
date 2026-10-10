import { describe, expect, test } from 'vitest';
import { DEFAULT_SEVERITIES, ISSUE_CODES, compileRuleset, exampleRuleset } from '../src/shared/core';
import type { Ruleset } from '../src/shared/core';
import { example } from './helpers';

const clone = (): Ruleset & Record<string, any> => JSON.parse(JSON.stringify(exampleRuleset));

/** Compiles a modified copy of the example and returns its problems. */
function problemsOf(change: (ruleset: Record<string, any>) => void): string[] {
	const copy = clone();
	change(copy);
	const result = compileRuleset(copy);
	expect(result.ruleset).toBeNull();
	return result.problems;
}

describe('compileRuleset', () => {
	test('compiles the example ruleset without problems', () => {
		const result = compileRuleset(exampleRuleset);
		expect(result.problems).toEqual([]);
		expect(result.ruleset).not.toBeNull();
	});

	test('fills defaults and builds lookup maps', () => {
		expect(example.direction).toBe('LR');
		expect(example.defaultEdgeType).toBe('flow');
		expect(example.connectionRules).toMatchObject({ typeCheck: 'strict', allowSelfLoops: false, allowCycles: true, allowMultiEdges: false });
		expect([...example.nodeTypeMap.keys()]).toEqual(['start', 'task', 'approval', 'condition', 'notify', 'end', 'legacy_review']);
		expect([...example.edgeTypeMap.keys()]).toEqual(['flow', 'timeout']);
		expect(example.dataTypeMap.get('event')).toMatchObject({ label: 'Event', color: 'var(--theme--warning)' });
		expect(example.dataTypeMap.get('flow')!.acceptSet.has('event')).toBe(false);
	});

	test('resolves severities: built-in defaults with overrides applied', () => {
		expect(Object.keys(example.severities).sort()).toEqual([...ISSUE_CODES].sort());
		expect(example.severities).toEqual(DEFAULT_SEVERITIES);

		const warnings = ISSUE_CODES.filter((code) => DEFAULT_SEVERITIES[code] === 'warning').sort();
		expect(warnings).toEqual(['deprecated_node_type', 'min_connections', 'min_instances', 'min_nodes', 'not_connected', 'unreachable']);

		const result = compileRuleset({ ...clone(), severity: { unreachable: 'error', deprecated_node_type: 'off' } });
		expect(result.ruleset!.severities.unreachable).toBe('error');
		expect(result.ruleset!.severities.deprecated_node_type).toBe('off');
		expect(result.ruleset!.severities.cycle).toBe('error');
	});

	test('accepts a JSON string and gives the same result as the object', () => {
		const fromString = compileRuleset(JSON.stringify(exampleRuleset));
		expect(fromString.problems).toEqual([]);
		expect(fromString.ruleset!.nodeTypes).toEqual(example.nodeTypes);
	});

	test('reports a missing ruleset', () => {
		for (const raw of [null, undefined, '', '   ']) {
			expect(compileRuleset(raw)).toEqual({ ruleset: null, problems: ['No ruleset is configured.'] });
		}
	});

	test('reports invalid JSON and non-objects', () => {
		expect(compileRuleset('{ nope')!.problems[0]).toMatch(/^The ruleset is not valid JSON/);
		expect(compileRuleset([1, 2]).problems).toEqual(['The ruleset must be a JSON object.']);
		expect(compileRuleset(42).problems).toEqual(['The ruleset must be a JSON object.']);
	});

	test('is a deep copy: later changes to the input do not leak in', () => {
		const copy = clone();
		const compiled = compileRuleset(copy).ruleset!;
		copy.nodeTypes[0]!.label = 'Changed';
		copy.nodeTypes.push({ key: 'late', label: 'Late' });
		expect(compiled.nodeTypeMap.get('start')!.label).toBe('Start');
		expect(compiled.nodeTypeMap.has('late')).toBe(false);
	});

	test('keeps unknown keys for forward compatibility', () => {
		const result = compileRuleset({ ...clone(), migrations: [{ toVersion: 2 }] });
		expect(result.problems).toEqual([]);
		expect((result.ruleset as unknown as Record<string, unknown>)['migrations']).toEqual([{ toVersion: 2 }]);
	});

	test('synthesises a default edge type when none is declared', () => {
		const minimal = {
			format: 'directus-node-graph-ruleset',
			schemaVersion: 1,
			key: 'minimal',
			version: 1,
			name: 'Minimal',
			nodeTypes: [{ key: 'a', inputs: [{ key: 'in' }], outputs: [{ key: 'out' }] }],
		};

		const result = compileRuleset(minimal);
		expect(result.problems).toEqual([]);
		expect(result.ruleset!.edgeTypes).toEqual([{ key: 'default', label: 'Connection' }]);
		expect(result.ruleset!.defaultEdgeType).toBe('default');
		expect(result.ruleset!.nodeTypeMap.get('a')!.label).toBe('A');
	});

	test('reports header problems', () => {
		const problems = problemsOf((ruleset) => {
			ruleset['format'] = 'something-else';
			ruleset['schemaVersion'] = 2;
			delete ruleset['key'];
			ruleset['version'] = 1.5;
			ruleset['direction'] = 'RL';
		});

		expect(problems).toEqual(
			expect.arrayContaining([
				'format: must be "directus-node-graph-ruleset".',
				'schemaVersion: is not supported (expected 1).',
				'key: is required (a short identifier such as "approval-workflow").',
				'version: must be a whole number.',
				'direction: must be "LR" or "TB".',
			]),
		);
	});

	test('reports structural problems in node types, ports, fields and references', () => {
		const problems = problemsOf((ruleset) => {
			const types = ruleset['nodeTypes'];
			types[1].key = 'start'; // duplicate
			types[2].inputs[0].dataType = 'missing';
			types[2].outputs[0].edgeTypes = ['nope'];
			types[2].inputs[0].edgeTypes = ['flow'];
			types[2].outputs[1].minConnections = 3;
			types[2].outputs[1].maxConnections = 1;
			types[2].summaryFields = ['unknown_field'];
			types[3].dynamicOutputs.field = 'label'; // not json
			types[4].fields[0].meta.interface = 'list-m2m';
			types[4].fields[1].type = 'blob';
			types[4].fields.push({ field: 'constructor', type: 'string' });
			types[5].limits = { minInstances: 3, maxInstances: 1 };
			types[5].icon = 'Not An Icon';
			types[5].color = 'url(https://example.com/x.png)';
			types[6].key = 'has.dot';
		});

		const expected = [
			'nodeTypes[1].key: "start" is used twice.',
			'nodeTypes[2].inputs[0].dataType: "missing" is not a defined data type.',
			'nodeTypes[2].outputs[0].edgeTypes[0]: "nope" is not a defined edge type.',
			'nodeTypes[2].inputs[0].edgeTypes: only applies to outputs.',
			'nodeTypes[2].outputs[1]: minConnections (3) is larger than maxConnections (1).',
			'nodeTypes[2].summaryFields[0]: "unknown_field" is not a field of this node type.',
			'nodeTypes[3].dynamicOutputs.field: "label" must be a json field (a repeater).',
			'nodeTypes[4].fields[0].meta.interface: "list-m2m" needs a relation or a collection and cannot be used inside a node.',
			'nodeTypes[4].fields[1].type: "blob" is not a supported field type.',
			'nodeTypes[4].fields[2].field: "constructor" is not an allowed field key.',
			'nodeTypes[5].limits: minInstances (3) is larger than maxInstances (1).',
			'nodeTypes[5].icon: must be a Material Symbols name such as "task_alt".',
			'nodeTypes[5].color: must be a CSS colour such as "var(--theme--primary)" or "#6644ff".',
		];

		expect(problems).toEqual(expect.arrayContaining(expected));
		expect(problems.some((problem) => problem.startsWith('nodeTypes[6].key: "has.dot"'))).toBe(true);
	});

	test('reports problems in edge types, data types, rules, severity and the starter', () => {
		const problems = problemsOf((ruleset) => {
			ruleset['dataTypes'].push({ key: 'any' });
			ruleset['dataTypes'][0].accepts = ['ghost'];
			ruleset['edgeTypes'][0].style.path = 'smoothstep';
			ruleset['edgeTypes'][1].style.marker = 'arrowclosed';
			ruleset['connectionRules'].defaultEdgeType = 'missing';
			ruleset['connectionRules'].typeCheck = 'loose';
			ruleset['connectionRules'].pairs.rules.push({ source: 'ghost', target: 'end' });
			ruleset['connectionRules'].pairs.rules.push({ source: 'task', sourcePort: 'nope', target: 'end' });
			ruleset['graphRules'].entryNodeTypes = ['ghost'];
			ruleset['graphRules'].minNodes = 10;
			ruleset['graphRules'].maxNodes = 5;
			ruleset['severity'] = { made_up: 'error', cycle: 'fatal' };
			ruleset['starter'].nodes.push({ ref: 'start', type: 'ghost', position: { x: 'a' } });
			ruleset['starter'].edges = [{ source: 'start', sourceHandle: 'nope', target: 'end', targetHandle: 'in' }];
		});

		expect(problems).toEqual(
			expect.arrayContaining([
				'dataTypes[2].key: "any" is built in and cannot be redefined.',
				'dataTypes[0].accepts[0]: "ghost" is not a defined data type.',
				'edgeTypes[0].style.path: must be one of "bezier", "step", "straight".',
				'edgeTypes[1].style.marker: must be one of "arrow", "none".',
				'connectionRules.defaultEdgeType: "missing" is not a defined edge type.',
				'connectionRules.typeCheck: must be one of "strict", "off".',
				'connectionRules.pairs.rules[1].source: "ghost" is not a defined node type.',
				'graphRules.entryNodeTypes[0]: "ghost" is not a defined node type.',
				'graphRules: minNodes (10) is larger than maxNodes (5).',
				'severity.made_up: is not a known issue code.',
				'severity.cycle: must be "error", "warning" or "off".',
				'starter.nodes[2].ref: "start" is used twice.',
				'starter.nodes[2].type: "ghost" is not a defined node type.',
				'starter.nodes[2].position: must be { "x": number, "y": number }.',
			]),
		);
	});

	test('checks pair rule ports and starter edges once the structure is valid', () => {
		const pairProblems = problemsOf((ruleset) => {
			ruleset['connectionRules'].pairs.rules.push({ source: 'task', sourcePort: 'nope', target: 'end', targetPort: 'out' });
		});

		expect(pairProblems).toEqual([
			'connectionRules.pairs.rules[1].sourcePort: "nope" is not an output of "task".',
			'connectionRules.pairs.rules[1].targetPort: "out" is not an input of "end".',
		]);

		const starterProblems = problemsOf((ruleset) => {
			ruleset['starter'].edges = [{ source: 'start', sourceHandle: 'nope', target: 'end', targetHandle: 'in' }];
		});

		expect(starterProblems).toEqual(['starter.edges[0].sourceHandle: "nope" is not an output of "start".']);
	});

	test('accepts `field.*` pair patterns for dynamic outputs', () => {
		const copy = clone();
		copy.connectionRules!.pairs!.rules.push({ source: 'condition', sourcePort: 'branches.*', target: 'end' });
		expect(compileRuleset(copy).problems).toEqual([]);
	});

	test('accepts theme colours and rejects anything that could load a resource or break out of a declaration', () => {
		const withColor = (color: string) => {
			const copy = clone();
			copy.nodeTypes[1]!.color = color;
			return compileRuleset(copy).problems;
		};

		for (const color of ['var(--theme--primary)', '#6644ff', 'rgb(10, 20, 30)', 'color-mix(in srgb, var(--theme--danger), white 20%)', 'rebeccapurple']) {
			expect(withColor(color)).toEqual([]);
		}

		for (const color of ['url(x)', 'image-set(x 1x)', '-webkit-image-set(x 1x)', 'cross-fade(red, blue)', 'red; background: blue', 'red}', '"red"', 'paint(x)', 'expression(alert(1))']) {
			expect(withColor(color)).toHaveLength(1);
		}
	});

	test('requires entry types when reachability is required', () => {
		const problems = problemsOf((ruleset) => {
			delete ruleset['graphRules'].entryNodeTypes;
		});

		expect(problems).toEqual(['graphRules.requireReachableFromEntry: needs at least one entry node type in entryNodeTypes.']);
	});

	test('reports forbidden keys instead of copying them', () => {
		const json = JSON.stringify(exampleRuleset).replace('"key":"approval-workflow"', '"key":"approval-workflow","__proto__":{"polluted":true}');
		const result = compileRuleset(json);

		expect(result.ruleset).toBeNull();
		expect(result.problems).toEqual(['__proto__: the key is not allowed.']);
		expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
	});

	test('never throws', () => {
		const inputs: unknown[] = [
			{ nodeTypes: [null, 1, 'x', [], { key: 1 }] },
			{ key: 'k', nodeTypes: [{ key: 'a', inputs: [null], outputs: 'x', fields: [null, { field: 'f' }] }] },
			{ key: 'k', nodeTypes: [{ key: 'a' }], edgeTypes: [null], connectionRules: { pairs: { rules: [null] } } },
			{ key: 'k', nodeTypes: [{ key: 'a' }], starter: { nodes: [null], edges: [null] } },
			{ key: 'k', nodeTypes: [{ key: 'a', dynamicOutputs: null, limits: 'x' }], severity: [] },
		];

		for (const input of inputs) {
			expect(() => compileRuleset(input)).not.toThrow();
			expect(compileRuleset(input).ruleset).toBeNull();
		}
	});
});
