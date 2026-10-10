/**
 * The editor shell. The interface entry (src/interface.ts) needs only this:
 *
 *   import { defineInterface } from '@directus/extensions-sdk';
 *   import NodeGraphOptions from './shared/options-editor/NodeGraphOptions.vue';
 *   import { createNodeGraphInterface } from './shared/ui';
 *   import VueFlowCanvas from './canvas/VueFlowCanvas.vue';
 *
 *   export default defineInterface({
 *   	id: 'node-graph',
 *   	name: 'Node Graph',
 *   	icon: 'account_tree',
 *   	types: ['json'],
 *   	group: 'other',
 *   	options: NodeGraphOptions,
 *   	recommendedDisplays: ['node-graph-summary'],
 *   	component: createNodeGraphInterface({
 *   		interfaceId: 'node-graph',
 *   		component: VueFlowCanvas,
 *   	}),
 *   });
 *
 * Or, as an SFC: `<NodeGraphInterface v-bind="$attrs" :registration="registration" />`
 * in a component with `inheritAttrs: false`.
 */

import { defineComponent, h, markRaw, type Component } from 'vue';
import type { CanvasRegistration } from './canvas-contract';
import NodeGraphInterface from './NodeGraphInterface.vue';

export { default as NodeGraphInterface } from './NodeGraphInterface.vue';
export { PALETTE_DRAG_MIME } from './canvas-contract';
export type { CanvasEmits, CanvasExpose, CanvasProps, CanvasRegistration, ReferenceLabels, Selection } from './canvas-contract';

/**
 * The interface component for `defineInterface({ component })`: the shared
 * NodeGraphInterface with the canvas bound in.
 *
 * Everything the form passes (value, disabled, loading, the interface
 * options, `onInput`, …) arrives as attrs and is handed on unchanged, so
 * NodeGraphInterface sees the props exactly as if the form rendered it
 * directly. Vue camelises the hyphenated names the form uses
 * (form-field-interface.vue:60-85) when it resolves NodeGraphInterface's
 * declared props.
 */
export function createNodeGraphInterface(registration: CanvasRegistration): Component {
	// The canvas component is a constant, not state: keep Vue from proxying it.
	const bound: CanvasRegistration = { ...registration, component: markRaw(registration.component) };

	return defineComponent({
		name: `NodeGraphInterface_${registration.interfaceId.replace(/[^A-Za-z0-9]/g, '_')}`,
		inheritAttrs: false,
		setup(_props, { attrs }) {
			return () => h(NodeGraphInterface, { ...attrs, registration: bound });
		},
	});
}
