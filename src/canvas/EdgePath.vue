<script setup lang="ts">
/**
 * The one edge type the Vue Flow canvas registers ('ng-edge'): the Flows
 * arrow of docs/design.md §7 drawn as an `.ng-edge` group (halo, line, open
 * chevron, wide hit path) and the label pill through EdgeLabelRenderer.
 *
 * It deliberately avoids BaseEdge, EdgeText and the `vue-flow__edge-path`
 * class: Vue Flow's structural CSS paints those #b1b1b7 at 1px and #555 when
 * selected (style.css:69-105), and edge markers live in shared <defs> that
 * cannot follow the edge's CSS state. The chevron is a second path inside
 * the group instead, so it takes the edge's colour from CSS like the line.
 *
 * Vue Flow hands over the handle positions (getHandlePosition,
 * vue-flow-core.mjs:4274-4291): the source at the handle's outer edge and
 * the target at the target handle's outer edge. The line stops MARKER_GAP
 * before the target, so the chevron tip sits 2px short of the ring, as
 * Flows arrows stop short of the operation handle.
 */

import { EdgeLabelRenderer, getBezierPath, getSmoothStepPath, getStraightPath, type Position } from '@vue-flow/core';
import { computed, inject } from 'vue';
import { edgeLabel } from '../shared/core';
import { CANVAS_CONTEXT, chevronPath, fromFlowId, MARKER_GAP, offsetFromSide, STEP_CORNER_RADIUS } from './context';

defineOptions({ inheritAttrs: false });

/*
 * The members of Vue Flow's EdgeProps this component uses
 * (vue-flow-core.mjs:8950-8980); the rest arrive as attrs. Positions are
 * declared as plain strings (Vue Flow's Position enum values) so the SFC
 * compiler does not have to resolve a type from node_modules.
 */
const props = defineProps<{
	id: string;
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	sourcePosition: string;
	targetPosition: string;
}>();

const context = inject(CANVAS_CONTEXT)!;

const edgeId = computed(() => fromFlowId(props.id));
const edge = computed(() => context.edgeById.value.get(edgeId.value) ?? null);

const edgeType = computed(() => {
	const ruleset = context.ruleset.value;
	return ruleset.edgeTypeMap.get(edge.value?.type ?? ruleset.defaultEdgeType) ?? null;
});

const style = computed(() => edgeType.value?.style ?? {});

/** The edge type's colour, else the source port's data-type colour (docs/design.md §7.1). */
const color = computed(() => {
	if (style.value.color) return style.value.color;

	const current = edge.value;
	if (!current) return null;

	const port = context.ports.value.get(current.source)?.outputs.find((candidate) => candidate.key === current.sourceHandle);
	return port?.color ?? null;
});

const severity = computed(() => context.edgeSeverity.value.get(edgeId.value) ?? null);
const selected = computed(() => context.selectedEdges.value.has(edgeId.value));
const label = computed(() => (edge.value ? edgeLabel(context.ruleset.value, edge.value, context.references.value?.resolve) : ''));

const groupClass = computed(() => ({
	'ng-edge--selected': selected.value,
	'ng-edge--error': severity.value === 'error',
	'ng-edge--warning': severity.value === 'warning',
	'ng-edge--dashed': style.value.dashed === true,
	'ng-edge--animated': style.value.animated === true,
}));

const labelClass = computed(() => ({
	'ng-edge-label--selected': selected.value,
	'ng-edge-label--error': !selected.value && severity.value === 'error',
	'ng-edge-label--warning': !selected.value && severity.value === 'warning',
}));

// Applied with setProperty by Vue's style patching; the colour passed compileRuleset's isSafeColor (docs/design.md §3).
const groupStyle = computed(() => (color.value ? { '--ng-edge-color': color.value } : {}));

const geometry = computed(() => {
	const tip = offsetFromSide(props.targetX, props.targetY, props.targetPosition, MARKER_GAP);

	const params = {
		sourceX: props.sourceX,
		sourceY: props.sourceY,
		sourcePosition: props.sourcePosition as Position,
		targetX: tip.x,
		targetY: tip.y,
		targetPosition: props.targetPosition as Position,
	};

	let result: [path: string, labelX: number, labelY: number, ...rest: number[]];

	switch (style.value.path) {
		case 'step':
			// Orthogonal with the Flows 10px corner; Vue Flow routes backward edges around the cards.
			result = getSmoothStepPath({ ...params, borderRadius: STEP_CORNER_RADIUS });
			break;
		case 'straight':
			result = getStraightPath(params);
			break;
		default:
			result = getBezierPath(params);
	}

	return {
		path: result[0],
		labelX: result[1],
		labelY: result[2],
		marker: style.value.marker === 'none' ? null : chevronPath(tip.x, tip.y, props.targetPosition),
	};
});

const labelStyle = computed(() => ({
	transform: `translate(-50%, -50%) translate(${geometry.value.labelX}px, ${geometry.value.labelY}px)`,
}));
</script>

<template>
	<g class="ng-edge" :class="groupClass" :style="groupStyle">
		<path class="ng-edge__halo" :d="geometry.path" />
		<path class="ng-edge__path" :d="geometry.path" />
		<path v-if="geometry.marker" class="ng-edge__marker" :d="geometry.marker" />
		<path class="ng-edge__hit" :d="geometry.path" />
	</g>

	<EdgeLabelRenderer v-if="label">
		<!-- nodrag/nopan keep the pill from starting a pan or a drag (Vue Flow's d3 filters, vue-flow-core.mjs:8549-8552) -->
		<div
			class="ng-edge-label ng-vueflow-edge-label nodrag nopan"
			:class="labelClass"
			:style="labelStyle"
			@click.stop="context.selectEdge(props.id)"
		>
			{{ label }}
		</div>
	</EdgeLabelRenderer>
</template>
