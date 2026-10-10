<script setup lang="ts">
/**
 * The node-graph summary display (docs/design.md §10.3): the field row's
 * text in table cells and display templates, with a small error icon when
 * the graph has errors and the stock `--` for an empty value.
 */

import { computed } from 'vue';
import '../ui/theme.css';
import { displaySummary } from './summary';

const props = defineProps<{
	value?: unknown;
	/** The field's interface options (ruleset, template), passed by RenderDisplay. */
	interfaceOptions?: Record<string, unknown> | null;
}>();

const summary = computed(() => displaySummary(props.value, props.interfaceOptions));

const errorTooltip = computed(() => {
	const count = summary.value?.errorCount ?? 0;
	return `${count} ${count === 1 ? 'error' : 'errors'}`;
});
</script>

<template>
	<value-null v-if="!summary" />

	<span v-else class="node-graph-display">
		<v-icon
			v-if="summary.errorCount > 0"
			v-tooltip="errorTooltip"
			class="ng-display-error"
			name="error"
			small
			color="var(--theme--danger)"
		/>
		<v-text-overflow class="ng-display-text" :text="summary.text" />
	</span>
</template>

<style scoped>
.node-graph-display {
	display: inline-flex;
	gap: 0.25rem;
	align-items: center;
	max-inline-size: 100%;
	vertical-align: middle;
}

.ng-display-error {
	flex: none;
}

/* Same line height as the stock text display (render-display.vue:43-45) */
.ng-display-text {
	min-inline-size: 0;
	line-height: 1.25rem;
}
</style>
