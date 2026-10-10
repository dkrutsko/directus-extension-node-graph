/**
 * "Approval workflow": the example ruleset.
 *
 * It is designed to exercise every feature at least once: two data types
 * with an incompatible pair, select / radio / multiline / repeater fields,
 * required fields and defaults, title and summary templates, instance limits,
 * a non-deletable node, a deprecated type, dynamic outputs, two edge types
 * with fields and label templates, a port that allows both edge types, a
 * deny pair rule with a custom message, reachability from an entry type, and
 * a starter graph.
 *
 * The same object, as pretty JSON, is examples/approval-workflow.json (for
 * pasting into the field options; tests/options.test.ts fails when the two
 * drift apart) and is offered as the ruleset option's template
 * (../options.ts).
 */

import type { NodeGraphField, PortDef, Ruleset } from './types';

const flowIn: PortDef = { key: 'in', label: 'In', dataType: 'flow', minConnections: 1 };

const taskFields: NodeGraphField[] = [
	{
		field: 'title',
		name: 'Title',
		type: 'string',
		meta: { interface: 'input', width: 'full', required: true, options: { placeholder: 'What needs to be done?' } },
	},
	{
		field: 'assignee',
		name: 'Assignee',
		type: 'string',
		meta: {
			interface: 'select-dropdown',
			width: 'half',
			options: {
				choices: [
					{ text: 'Requester', value: 'requester' },
					{ text: 'Team lead', value: 'team_lead' },
					{ text: 'Security', value: 'security' },
					{ text: 'IT', value: 'it' },
				],
			},
		},
	},
	{
		field: 'due_days',
		name: 'Due in (days)',
		type: 'integer',
		meta: { interface: 'input', width: 'half', options: { min: 0 } },
		schema: { default_value: 3 },
	},
];

export const exampleRuleset: Ruleset = {
	format: 'directus-node-graph-ruleset',
	schemaVersion: 1,
	key: 'approval-workflow',
	version: 1,
	name: 'Approval workflow',
	direction: 'LR',
	dataTypes: [
		{ key: 'flow', label: 'Control flow', color: 'var(--theme--primary)' },
		{ key: 'event', label: 'Event', color: 'var(--theme--warning)' },
	],
	nodeTypes: [
		{
			key: 'start',
			label: 'Start',
			icon: 'play_arrow',
			color: 'var(--theme--primary)',
			category: 'Flow',
			description: 'Where the workflow begins. Every workflow has exactly one Start.',
			deletable: false,
			limits: { minInstances: 1, maxInstances: 1 },
			titleTemplate: '{{title}}',
			fields: [
				{
					field: 'title',
					name: 'Title',
					type: 'string',
					meta: { interface: 'input', width: 'full', options: { placeholder: 'Request received' } },
				},
			],
			outputs: [{ key: 'next', label: 'Next', dataType: 'flow', minConnections: 1, maxConnections: 1, edgeTypes: ['flow'] }],
		},
		{
			key: 'task',
			label: 'Task',
			icon: 'task_alt',
			category: 'Steps',
			description: 'A piece of work assigned to someone, with a due date.',
			titleTemplate: '{{title}}',
			summaryFields: ['assignee', 'due_days'],
			fields: taskFields,
			inputs: [flowIn],
			outputs: [{ key: 'next', label: 'Next', dataType: 'flow', maxConnections: 1, edgeTypes: ['flow', 'timeout'] }],
		},
		{
			key: 'approval',
			label: 'Approval',
			icon: 'how_to_reg',
			color: 'var(--theme--secondary)',
			category: 'Steps',
			description: 'Someone approves or rejects the request. Can escalate when it takes too long.',
			titleTemplate: 'Approval by {{approver}}',
			summaryFields: ['sla_hours'],
			fields: [
				{
					field: 'approver',
					name: 'Approver',
					type: 'string',
					meta: {
						interface: 'select-dropdown',
						width: 'half',
						required: true,
						options: {
							choices: [
								{ text: 'Team lead', value: 'team_lead' },
								{ text: 'Security', value: 'security' },
								{ text: 'Manager', value: 'manager' },
							],
						},
					},
				},
				{
					field: 'sla_hours',
					name: 'SLA (hours)',
					type: 'integer',
					meta: { interface: 'input', width: 'half', options: { min: 1 } },
					schema: { default_value: 24 },
				},
			],
			inputs: [flowIn],
			outputs: [
				{ key: 'approved', label: 'Approved', dataType: 'flow', maxConnections: 1, edgeTypes: ['flow'] },
				{ key: 'rejected', label: 'Rejected', dataType: 'flow', maxConnections: 1, edgeTypes: ['flow'] },
				{ key: 'escalate', label: 'Escalate', dataType: 'event', edgeTypes: ['flow'] },
			],
		},
		{
			key: 'condition',
			label: 'Condition',
			icon: 'call_split',
			category: 'Logic',
			description: 'Sends the request down one of several branches.',
			titleTemplate: '{{label}}',
			fields: [
				{
					field: 'label',
					name: 'Label',
					type: 'string',
					meta: { interface: 'input', width: 'full', options: { placeholder: 'e.g. Which system?' } },
				},
				{
					field: 'branches',
					name: 'Branches',
					type: 'json',
					meta: {
						interface: 'list',
						width: 'full',
						note: 'Each branch becomes an output. Reordering branches moves their connections.',
						options: {
							template: '{{label}}',
							addLabel: 'Add branch',
							fields: [
								{
									field: 'label',
									name: 'Label',
									type: 'string',
									meta: { interface: 'input', width: 'full', options: { placeholder: 'e.g. Production access' } },
								},
							],
						},
					},
				},
			],
			inputs: [flowIn],
			outputs: [{ key: 'else', label: 'Otherwise', dataType: 'flow', maxConnections: 1, edgeTypes: ['flow'] }],
			dynamicOutputs: {
				field: 'branches',
				labelTemplate: '{{label}}',
				placement: 'start',
				port: { dataType: 'flow', maxConnections: 1, edgeTypes: ['flow'] },
			},
		},
		{
			key: 'notify',
			label: 'Notify',
			icon: 'notifications',
			category: 'Actions',
			description: 'Sends a message by email or Slack. Can be triggered by an escalation.',
			titleTemplate: 'Notify via {{channel}}',
			fields: [
				{
					field: 'channel',
					name: 'Channel',
					type: 'string',
					meta: {
						interface: 'select-radio',
						width: 'full',
						options: {
							choices: [
								{ text: 'Email', value: 'email' },
								{ text: 'Slack', value: 'slack' },
							],
						},
					},
				},
				{
					field: 'message',
					name: 'Message',
					type: 'text',
					meta: { interface: 'input-multiline', width: 'full', options: { placeholder: 'What should the message say?' } },
				},
			],
			inputs: [
				{ key: 'in', label: 'In', dataType: 'flow' },
				{ key: 'trigger', label: 'Trigger', dataType: 'event' },
			],
			outputs: [{ key: 'next', label: 'Next', dataType: 'flow', maxConnections: 1, edgeTypes: ['flow'] }],
		},
		{
			key: 'end',
			label: 'End',
			icon: 'stop_circle',
			category: 'Flow',
			description: 'Where the workflow finishes, with its outcome.',
			limits: { minInstances: 1 },
			titleTemplate: 'End: {{outcome}}',
			fields: [
				{
					field: 'outcome',
					name: 'Outcome',
					type: 'string',
					meta: {
						interface: 'select-dropdown',
						width: 'full',
						options: {
							choices: [
								{ text: 'Approved', value: 'approved' },
								{ text: 'Rejected', value: 'rejected' },
								{ text: 'Cancelled', value: 'cancelled' },
							],
						},
					},
				},
			],
			inputs: [flowIn],
		},
		{
			key: 'legacy_review',
			label: 'Legacy review',
			icon: 'history',
			category: 'Steps',
			description: 'Replaced by Task. Existing reviews keep working but cannot be added.',
			deprecated: true,
			titleTemplate: '{{title}}',
			fields: [
				{
					field: 'title',
					name: 'Title',
					type: 'string',
					meta: { interface: 'input', width: 'full' },
				},
			],
			inputs: [flowIn],
			outputs: [{ key: 'next', label: 'Next', dataType: 'flow', maxConnections: 1, edgeTypes: ['flow', 'timeout'] }],
		},
	],
	edgeTypes: [
		{
			key: 'flow',
			label: 'Flow',
			style: { path: 'bezier', dashed: false, marker: 'arrow' },
			labelTemplate: '{{label}}',
			fields: [
				{
					field: 'label',
					name: 'Label',
					type: 'string',
					meta: { interface: 'input', width: 'full', options: { placeholder: 'Optional label' } },
				},
			],
		},
		{
			key: 'timeout',
			label: 'Timeout',
			style: { path: 'step', dashed: true, color: 'var(--theme--warning)', marker: 'arrow' },
			labelTemplate: 'after {{after_hours}} h',
			fields: [
				{
					field: 'after_hours',
					name: 'After (hours)',
					type: 'integer',
					meta: { interface: 'input', width: 'full', options: { min: 1 } },
				},
			],
		},
	],
	connectionRules: {
		defaultEdgeType: 'flow',
		typeCheck: 'strict',
		allowSelfLoops: false,
		allowCycles: true,
		allowMultiEdges: false,
		pairs: {
			mode: 'deny',
			rules: [{ source: 'start', target: 'end', message: 'Start cannot go straight to End.' }],
		},
	},
	graphRules: {
		entryNodeTypes: ['start'],
		requireReachableFromEntry: true,
		maxNodes: 200,
		maxEdges: 400,
	},
	starter: {
		nodes: [
			{ ref: 'start', type: 'start', position: { x: 0, y: 0 } },
			{ ref: 'end', type: 'end', position: { x: 480, y: 0 } },
		],
	},
};
