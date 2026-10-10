import { defineDisplay } from '@directus/extensions-sdk';
import { SummaryDisplay, summaryHandler } from './shared/display';

/**
 * The node-graph summary for layouts and display templates ("3 nodes · 2
 * connections", with an error icon when the stored graph has errors).
 *
 * Directus 11.17.4 hands a display the field's interface options as
 * `interfaceOptions` (app/src/views/private/components/render-display.vue:8-17,
 * render-template.vue:115-128), so the field's own ruleset and template are
 * used and the display needs no options of its own.
 */
export default defineDisplay({
	id: 'node-graph-summary',
	name: 'Node Graph Summary',
	description: 'Node and connection counts of a node-graph field',
	icon: 'account_tree',
	types: ['json'],
	component: SummaryDisplay,
	handler: summaryHandler,
	options: null,
});
