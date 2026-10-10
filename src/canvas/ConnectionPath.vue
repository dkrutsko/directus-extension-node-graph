<script setup lang="ts">
/**
 * The line drawn while a connection is being made, or while an edge end is
 * dragged to another port (Vue Flow's `#connection-line` slot,
 * vue-flow-core.mjs:9207-9221). docs/design.md §7.5: 2px in the source
 * port's colour, dashed until it snaps to a valid port, danger over an
 * invalid one, no chevron, no pointer events.
 *
 * Validity comes from the canvas's own canConnect() verdicts, not from Vue
 * Flow's `connectionStatus`: while an edge end is being moved Vue Flow
 * validates with the store-level isValidConnection only (EdgeWrapper,
 * vue-flow-core.mjs:8867-8875), which this canvas never sets, so its status
 * would say "valid" for every port.
 */

import { getBezierPath, type Position } from '@vue-flow/core';
import { computed, inject } from 'vue';
import { CANVAS_CONTEXT } from './context';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
	sourceX: number;
	sourceY: number;
	sourcePosition: string;
	targetX: number;
	targetY: number;
	targetPosition: string;
}>();

const context = inject(CANVAS_CONTEXT)!;

const path = computed(
	() =>
		getBezierPath({
			sourceX: props.sourceX,
			sourceY: props.sourceY,
			sourcePosition: props.sourcePosition as Position,
			targetX: props.targetX,
			targetY: props.targetY,
			targetPosition: props.targetPosition as Position,
		})[0],
);

const status = computed(() => {
	const target = context.targetHandle.value;
	const verdict = target ? context.drawing.value?.verdicts.get(target) : undefined;
	if (!verdict) return null;
	return verdict.ok ? 'valid' : 'invalid';
});

const style = computed(() => (context.drawing.value ? { '--ng-connection-color': context.drawing.value.color } : {}));
</script>

<template>
	<path
		class="ng-connection"
		:class="{ 'ng-connection--valid': status === 'valid', 'ng-connection--invalid': status === 'invalid' }"
		:style="style"
		:d="path"
	/>
</template>
