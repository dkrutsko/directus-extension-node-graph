<script setup lang="ts">
/**
 * The one node type the Vue Flow canvas registers ('ng-node'): the Directus
 * card of docs/design.md §5 plus one Vue Flow <Handle> per resolved port.
 *
 * Every node, whatever its ruleset type, is rendered by this component, so no
 * `.vue-flow__node-default|input|output` rule (theme-default.css) can ever
 * match (docs/design.md §13.1). The card reads its node from the canvas
 * context by id instead of from Vue Flow's `data`, so Vue Flow never holds
 * document data.
 *
 * The component renders a fragment: the card, then the handles as its
 * siblings. Vue Flow positions handles absolutely against the node wrapper
 * (`.vue-flow__node` is `position: absolute`, style.css:140-149), which has
 * exactly the card's size, so the card itself needs no `position`.
 */

import { Handle, Position as HandlePosition, useVueFlow } from '@vue-flow/core';
import { computed, inject, nextTick, watch } from 'vue';
import { nodeSummary, nodeTitle, type NodePorts, type ResolvedPort } from '../shared/core';
import { CANVAS_CONTEXT, fromFlowId, handleKey, handleOffset, portKey, toFlowId, type HandleType } from './context';

defineOptions({ inheritAttrs: false });

/*
 * Vue Flow passes every NodeProps member (vue-flow-core.mjs:9602-9623); only
 * these two are used. The rest arrive as attrs, which a fragment cannot
 * inherit, hence `inheritAttrs: false`.
 */
const props = withDefaults(defineProps<{ id: string; dragging?: boolean }>(), { dragging: false });

const context = inject(CANVAS_CONTEXT)!;
const { updateNodeInternals } = useVueFlow();

const EMPTY_PORTS: NodePorts = { inputs: [], outputs: [] };

const nodeId = computed(() => fromFlowId(props.id));
const node = computed(() => context.nodeById.value.get(nodeId.value) ?? null);
const type = computed(() => (node.value ? (context.ruleset.value.nodeTypeMap.get(node.value.type) ?? null) : null));
const ports = computed(() => context.ports.value.get(nodeId.value) ?? EMPTY_PORTS);

/** A node whose type the ruleset does not know: the dashed placeholder card (docs/design.md §5.6). */
const placeholder = computed(() => node.value !== null && type.value === null);
const deprecated = computed(() => type.value?.deprecated === true);

const icon = computed(() => {
	if (placeholder.value) return 'help';
	if (type.value?.icon) return type.value.icon;
	return type.value?.category ? 'category' : 'account_tree';
});

const typeLabel = computed(() => (placeholder.value ? 'Unknown type' : (type.value?.label ?? '')));

/** The raw type key for unknown types (shown in Fira Mono); nodeTitle() otherwise. */
const title = computed(() => {
	if (!node.value) return '';
	if (placeholder.value) return node.value.type || 'Unknown node';
	return nodeTitle(context.ruleset.value, node.value);
});

const summary = computed(() => (node.value && !placeholder.value ? nodeSummary(context.ruleset.value, node.value) : []));

/*
 * Issue state as primitives: the shell validates on every drag frame and
 * hands a new issues array each time, and computeds that return an equal
 * number or string do not re-render the card.
 */
const errorCount = computed(() => context.nodeIssues.value.get(nodeId.value)?.errors ?? 0);
const warningCount = computed(() => context.nodeIssues.value.get(nodeId.value)?.warnings ?? 0);
const errorText = computed(() => context.nodeIssues.value.get(nodeId.value)?.errorText ?? '');
const warningText = computed(() => context.nodeIssues.value.get(nodeId.value)?.warningText ?? '');

const selected = computed(() => context.selectedNodes.value.has(nodeId.value));

const cardClass = computed(() => ({
	'ng-node--selected': selected.value,
	'ng-node--dragging': props.dragging,
	'ng-node--error': errorCount.value > 0 || placeholder.value,
	'ng-node--deprecated': deprecated.value,
	'ng-node--placeholder': placeholder.value,
}));

/*
 * The node colour reaches the DOM only as a custom property in a style
 * object: Vue's runtime applies `--*` keys with style.setProperty()
 * (runtime-dom patchStyle), never by concatenating a style string, and the
 * value has passed compileRuleset's isSafeColor check (docs/design.md §3).
 */
const cardStyle = computed(() => (type.value?.color ? { '--ng-node-color': type.value.color } : {}));

/* Ports and handles -------------------------------------------------------- */

interface PlacedHandle {
	port: ResolvedPort;
	/** Vue Flow handle id (the port key, encoded; see toFlowId). */
	handleId: string;
	type: HandleType;
	position: HandlePosition;
	offset: Record<string, string>;
}

/**
 * Ports grouped by card side. Left and right ports get a label row each
 * (docs/design.md §5.3); top and bottom ports sit on the card edge with
 * their label in a tooltip (§5.1). R, the number of port rows, is the longer
 * of the two side columns, which is what makes the card height follow the
 * §5.1 formula.
 */
const layout = computed(() => {
	const sides: Record<ResolvedPort['side'], ResolvedPort[]> = { left: [], right: [], top: [], bottom: [] };

	for (const port of [...ports.value.inputs, ...ports.value.outputs]) {
		sides[port.side].push(port);
	}

	const handles: PlacedHandle[] = [];

	for (const side of ['left', 'right', 'top', 'bottom'] as const) {
		sides[side].forEach((port, index) => {
			handles.push({
				port,
				handleId: toFlowId(port.key),
				type: port.direction === 'input' ? 'target' : 'source',
				position: side as HandlePosition,
				offset: handleOffset(side, index, sides[side].length),
			});
		});
	}

	return {
		left: sides.left,
		right: sides.right,
		rows: Math.max(sides.left.length, sides.right.length),
		handles,
		labelled: handles.filter((handle) => handle.port.side === 'left' || handle.port.side === 'right'),
		unlabelled: handles.filter((handle) => handle.port.side === 'top' || handle.port.side === 'bottom'),
	};
});

/*
 * Vue Flow measures handle bounds when a node's size changes (ResizeObserver
 * → updateNodeDimensions, vue-flow-core.mjs:6305-6342) and appends bounds for
 * newly mounted handles (Handle onMounted, vue-flow-core.mjs:7007-7029), but never drops the
 * bounds of a removed handle or re-measures handles that moved without a
 * size change. Whenever the set or order of ports changes (a repeater item
 * added to a Condition, a placeholder appearing for an edge), ask it to
 * re-measure this node once the DOM is updated.
 */
const portSignature = computed(() =>
	layout.value.handles.map((handle) => `${handle.port.side}:${handle.type}:${handle.port.key}`).join('\u0000'),
);

watch(portSignature, () => nextTick(() => updateNodeInternals([props.id])), { flush: 'post' });

/** Ports named by an error / a warning on this node, as strings so an unchanged set never re-renders the handles. */
const portIssues = computed(() => context.portsWithIssues.value.get(nodeId.value) ?? '');
const portWarnings = computed(() => context.portsWithWarnings.value.get(nodeId.value) ?? '');

function handleClass(handle: PlacedHandle): Record<string, boolean> {
	const { port } = handle;
	const flowKey = handleKey(props.id, handle.type, handle.handleId);
	const drawing = context.drawing.value;
	const verdict = drawing?.verdicts.get(flowKey);
	const isSource = drawing !== null && drawing.fromNode === props.id && drawing.fromHandle === handle.handleId && drawing.fromType === handle.type;

	return {
		'ng-handle--connected': context.connectedPorts.value.has(portKey(nodeId.value, port.direction, port.key)),
		'ng-handle--error': portIssues.value !== '' && portIssues.value.split('\u0000').includes(port.key),
		'ng-handle--warning': portWarnings.value !== '' && portWarnings.value.split('\u0000').includes(port.key),
		'ng-handle--undeclared': !port.declared,
		'ng-handle--source': isSource,
		'ng-handle--valid-target': verdict?.ok === true,
		'ng-handle--invalid-target': verdict !== undefined && !verdict.ok,
		'ng-handle--target': drawing !== null && context.targetHandle.value === flowKey,
	};
}

function handleStyle(handle: PlacedHandle): Record<string, string> {
	return { ...handle.offset, '--ng-port-color': handle.port.color };
}

function handleLabel(handle: PlacedHandle): string {
	return `${handle.port.direction === 'input' ? 'Input' : 'Output'}: ${handle.port.label}`;
}
</script>

<template>
	<div v-if="node" class="ng-node" :class="cardClass" :style="cardStyle">
		<div class="ng-node__header">
			<span class="ng-node__icon"><v-icon :name="icon" /></span>
			<span class="ng-node__heading">
				<span class="ng-node__type">
					{{ typeLabel }}
					<span v-if="deprecated" class="ng-node__type-suffix">· Deprecated</span>
				</span>
				<span class="ng-node__title">{{ title }}</span>
			</span>
			<span v-if="errorCount > 0 || warningCount > 0" class="ng-node__badges">
				<span v-if="errorCount > 0" v-tooltip="errorText" class="ng-badge ng-badge--error">
					<v-icon name="error" />
					{{ errorCount }}
				</span>
				<span v-if="warningCount > 0" v-tooltip="warningText" class="ng-badge ng-badge--warning">
					<v-icon name="warning" />
					{{ warningCount }}
				</span>
			</span>
		</div>

		<div v-if="layout.rows > 0" class="ng-node__ports">
			<div class="ng-node__inputs">
				<span
					v-for="port in layout.left"
					:key="`${port.direction}:${port.key}`"
					class="ng-port-label"
					:class="{ 'ng-port-label--undeclared': !port.declared }"
				>
					{{ port.label }}
				</span>
			</div>
			<div class="ng-node__outputs">
				<span
					v-for="port in layout.right"
					:key="`${port.direction}:${port.key}`"
					class="ng-port-label"
					:class="{ 'ng-port-label--undeclared': !port.declared }"
				>
					{{ port.label }}
				</span>
			</div>
		</div>

		<dl v-if="summary.length > 0" class="ng-node__summary">
			<div v-for="row in summary" :key="row.label">
				<dt>{{ row.label }}</dt>
				<dd>{{ row.value }}</dd>
			</div>
		</dl>
	</div>

	<!--
		Left and right handles have a label row on the card. Top and bottom
		handles carry their label as a tooltip instead; they are rendered in a
		separate list because the tooltip directive's `updated` hook hides any
		open tooltip even when its value stays empty (app/src/directives/tooltip.ts:38-48).
	-->
	<Handle
		v-for="handle in layout.labelled"
		:id="handle.handleId"
		:key="`${handle.type}:${handle.handleId}`"
		class="ng-handle"
		:class="handleClass(handle)"
		:style="handleStyle(handle)"
		:type="handle.type"
		:position="handle.position"
		:connectable="!context.readOnly.value && handle.port.declared"
		:is-valid-connection="context.isValidConnection"
		:aria-label="handleLabel(handle)"
	/>
	<Handle
		v-for="handle in layout.unlabelled"
		:id="handle.handleId"
		:key="`${handle.type}:${handle.handleId}`"
		v-tooltip="handle.port.label"
		class="ng-handle"
		:class="handleClass(handle)"
		:style="handleStyle(handle)"
		:type="handle.type"
		:position="handle.position"
		:connectable="!context.readOnly.value && handle.port.declared"
		:is-valid-connection="context.isValidConnection"
		:aria-label="handleLabel(handle)"
	/>
</template>
