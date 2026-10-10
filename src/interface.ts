import { defineInterface } from '@directus/extensions-sdk';
import VueFlowCanvas from './canvas/VueFlowCanvas.vue';
import { nodeGraphOptions } from './shared/options';
import { createNodeGraphInterface } from './shared/ui';

/**
 * The node-graph field.
 *
 * The editor shell (field row, drawer, palette, inspector, issues, history,
 * keyboard, apply and cancel) lives in ./shared/ui and knows nothing about the
 * graph library; the canvas that draws the graph with Vue Flow is ./canvas
 * and talks to the shell only through ./shared/ui/canvas-contract.ts. The
 * value is a json GraphDocument (docs/ruleset.md, "The stored graph
 * document").
 */
export default defineInterface({
	id: 'node-graph',
	name: 'Node Graph',
	description: 'Edit a node graph against a configurable ruleset',
	icon: 'account_tree',
	types: ['json'],
	group: 'other',
	options: nodeGraphOptions,
	recommendedDisplays: ['node-graph-summary'],
	component: createNodeGraphInterface({
		interfaceId: 'node-graph',
		component: VueFlowCanvas,
	}),
});
