/**
 * The summary display. The display entry (src/display.ts):
 *
 *   import { defineDisplay } from '@directus/extensions-sdk';
 *   import { SummaryDisplay, summaryHandler } from './shared/display';
 *
 *   export default defineDisplay({
 *   	id: 'node-graph-summary',
 *   	name: 'Node Graph Summary',
 *   	icon: 'account_tree',
 *   	types: ['json'],
 *   	component: SummaryDisplay,
 *   	handler: summaryHandler,
 *   	options: null,
 *   });
 */

export { default as SummaryDisplay } from './SummaryDisplay.vue';
export { displaySummary, summaryHandler, type DisplaySummary } from './summary';
