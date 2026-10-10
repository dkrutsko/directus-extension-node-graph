import { defineInterface } from '@directus/extensions-sdk';
import type { InterfaceConfig } from '@directus/types';
import VueFlowCanvas from './canvas/VueFlowCanvas.vue';
import NodeGraphOptions from './shared/options-editor/NodeGraphOptions.vue';
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
 *
 * `options` is a component, the options form of ./shared/options-editor:
 * Directus then mounts it in Data Model instead of rendering an options
 * array (directus-11.17.4/app/src/modules/settings/routes/data-model/field-detail/shared/extension-options.vue:35-40),
 * as the stock Repeater does with its own options (app/src/interfaces/list/index.ts:15).
 * The published InterfaceConfig type leaves components out of `options`
 * (`Exclude<ComponentOptions, any>` is never in @directus/types 15.0.3), so
 * the component is cast the way the app casts the Repeater's.
 */
export default defineInterface({
	id: 'node-graph',
	name: 'Node Graph',
	description: 'Edit a node graph against a configurable ruleset',
	icon: 'account_tree',
	types: ['json'],
	group: 'other',
	options: NodeGraphOptions as unknown as InterfaceConfig['options'],
	recommendedDisplays: ['node-graph-summary'],
	component: createNodeGraphInterface({
		interfaceId: 'node-graph',
		component: VueFlowCanvas,
	}),
});
