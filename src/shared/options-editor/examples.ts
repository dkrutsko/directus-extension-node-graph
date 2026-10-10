/**
 * The rulesets "Load Example" offers in the options form.
 *
 * - "Approval workflow" is the core example (../core/example-ruleset.ts,
 *   examples/approval-workflow.json), which uses every feature.
 * - "Simple approval" is examples/simple-approval.json, written out here
 *   because the app bundle cannot read files; tests/options-editor.test.ts
 *   fails when the two drift apart.
 * - "Blank" is the header of a new ruleset with no node types yet, so the
 *   problems list starts by asking for one.
 */

import { exampleRuleset } from '../core/example-ruleset';
import type { Ruleset } from '../core/types';
import { cloneJson } from '../core/util';

export const simpleApprovalRuleset: Ruleset = {
	format: 'directus-node-graph-ruleset',
	schemaVersion: 1,
	key: 'simple-approval',
	version: 1,
	name: 'Simple approval',
	direction: 'LR',
	dataTypes: [{ key: 'flow', label: 'Control flow', color: 'var(--theme--primary)' }],
	nodeTypes: [
		{
			key: 'start',
			label: 'Start',
			icon: 'play_arrow',
			category: 'Flow',
			deletable: false,
			limits: { minInstances: 1, maxInstances: 1 },
			titleTemplate: '{{title}}',
			fields: [{ field: 'title', name: 'Title', type: 'string', meta: { interface: 'input', width: 'full' } }],
			outputs: [{ key: 'next', label: 'Next', dataType: 'flow', minConnections: 1, maxConnections: 1 }],
		},
		{
			key: 'task',
			label: 'Task',
			icon: 'task_alt',
			category: 'Steps',
			titleTemplate: '{{title}}',
			summaryFields: ['assignee'],
			fields: [
				{ field: 'title', name: 'Title', type: 'string', meta: { interface: 'input', width: 'full', required: true } },
				{
					field: 'assignee',
					name: 'Assignee',
					type: 'string',
					meta: {
						interface: 'select-dropdown',
						width: 'half',
						options: {
							choices: [
								{ text: 'Team lead', value: 'lead' },
								{ text: 'Security', value: 'security' },
							],
						},
					},
				},
			],
			inputs: [{ key: 'in', label: 'In', dataType: 'flow', minConnections: 1 }],
			outputs: [{ key: 'next', label: 'Next', dataType: 'flow', maxConnections: 1 }],
		},
		{
			key: 'decision',
			label: 'Decision',
			icon: 'call_split',
			category: 'Steps',
			titleTemplate: '{{question}}',
			fields: [{ field: 'question', name: 'Question', type: 'string', meta: { interface: 'input', width: 'full' } }],
			inputs: [{ key: 'in', label: 'In', dataType: 'flow', minConnections: 1 }],
			outputs: [
				{ key: 'yes', label: 'Yes', dataType: 'flow', maxConnections: 1 },
				{ key: 'no', label: 'No', dataType: 'flow', maxConnections: 1 },
			],
		},
		{
			key: 'end',
			label: 'End',
			icon: 'stop_circle',
			category: 'Flow',
			limits: { minInstances: 1 },
			titleTemplate: 'End: {{outcome}}',
			fields: [
				{
					field: 'outcome',
					name: 'Outcome',
					type: 'string',
					meta: {
						interface: 'select-dropdown',
						options: {
							choices: [
								{ text: 'Approved', value: 'approved' },
								{ text: 'Rejected', value: 'rejected' },
							],
						},
					},
				},
			],
			inputs: [{ key: 'in', label: 'In', dataType: 'flow', minConnections: 1 }],
		},
	],
	edgeTypes: [
		{
			key: 'flow',
			label: 'Flow',
			style: { path: 'step', marker: 'arrow' },
			labelTemplate: '{{label}}',
			fields: [{ field: 'label', name: 'Label', type: 'string', meta: { interface: 'input' } }],
		},
	],
	connectionRules: {
		defaultEdgeType: 'flow',
		typeCheck: 'strict',
		allowSelfLoops: false,
		allowCycles: true,
		pairs: { mode: 'deny', rules: [{ source: 'start', target: 'end', message: 'Start cannot go straight to End.' }] },
	},
	graphRules: {
		entryNodeTypes: ['start'],
		requireReachableFromEntry: true,
		maxNodes: 100,
	},
};

/**
 * Not a valid ruleset on purpose: it has no node types yet, so the problems
 * list asks for the first one. Not a `Ruleset` for the same reason.
 */
export const blankRuleset: Record<string, unknown> = {
	format: 'directus-node-graph-ruleset',
	schemaVersion: 1,
	key: 'new-ruleset',
	version: 1,
	name: 'New ruleset',
	direction: 'LR',
	nodeTypes: [],
};

export interface RulesetExample {
	id: string;
	name: string;
	description: string;
	/** A fresh deep copy on every call, so loading an example twice never shares objects. */
	create: () => Record<string, unknown>;
}

export const RULESET_EXAMPLES: readonly RulesetExample[] = [
	{
		id: 'approval-workflow',
		name: 'Approval workflow',
		description: 'Seven node types, two edge types, dynamic outputs and a starter graph: every feature once.',
		create: () => cloneJson(exampleRuleset) as unknown as Record<string, unknown>,
	},
	{
		id: 'simple-approval',
		name: 'Simple approval',
		description: 'Four node types and one edge type. A good starting point.',
		create: () => cloneJson(simpleApprovalRuleset) as unknown as Record<string, unknown>,
	},
	{
		id: 'blank',
		name: 'Blank',
		description: 'Only the header. Add node types below.',
		create: () => cloneJson(blankRuleset),
	},
];
