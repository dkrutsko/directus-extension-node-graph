<script setup lang="ts">
/**
 * A list of validation issues (docs/design.md §9.6): errors first, each with its
 * icon, the message, and the title of the element it concerns. Used for the
 * whole graph in the issues section and for one element in the inspector.
 *
 * Clicking an issue that points at a node or edge emits `pick`; the editor
 * selects that element and pans the canvas to it.
 */

import { computed, inject } from 'vue';
import { nodeTitle, type CompiledRuleset, type GraphDocument, type GraphNode, type Issue } from '../core';
import { REFERENCE_LABELS } from './references';

const props = withDefaults(
	defineProps<{
		issues: Issue[];
		ruleset: CompiledRuleset;
		document: GraphDocument;
		/** Show the element title under each message (off inside the inspector, where the element is obvious). */
		showElement?: boolean;
		/** Text of the single row shown when there are no issues; null shows nothing. */
		emptyText?: string | null;
	}>(),
	{
		showElement: true,
		emptyText: 'No issues',
	},
);

const emit = defineEmits<{
	pick: [issue: Issue];
}>();

/* The editor's item reference labels (references.ts), so element titles match the cards; keys without them. */
const referenceLabels = inject(REFERENCE_LABELS, null);
const title = (node: GraphNode) => nodeTitle(props.ruleset, node, referenceLabels?.value.resolve);

const nodesById = computed(() => new Map(props.document.nodes.map((node) => [node.id, node])));
const edgesById = computed(() => new Map(props.document.edges.map((edge) => [edge.id, edge])));

/** Errors before warnings (validateDocument already sorts; this keeps the order for any caller). */
const sorted = computed(() => [
	...props.issues.filter((issue) => issue.severity === 'error'),
	...props.issues.filter((issue) => issue.severity === 'warning'),
]);

function elementText(issue: Issue): string | null {
	if (!props.showElement) return null;

	if (issue.nodeId) {
		const node = nodesById.value.get(issue.nodeId);
		return node ? title(node) : null;
	}

	if (issue.edgeId) {
		const edge = edgesById.value.get(issue.edgeId);
		if (!edge) return null;

		const source = nodesById.value.get(edge.source);
		const target = nodesById.value.get(edge.target);
		const from = source ? title(source) : edge.source;
		const to = target ? title(target) : edge.target;
		return `${from} → ${to}`;
	}

	return null;
}

function isPickable(issue: Issue): boolean {
	return (!!issue.nodeId && nodesById.value.has(issue.nodeId)) || (!!issue.edgeId && edgesById.value.has(issue.edgeId));
}

function pick(issue: Issue) {
	if (isPickable(issue)) emit('pick', issue);
}
</script>

<template>
	<v-list class="ng-issue-list">
		<template v-if="sorted.length > 0">
			<v-list-item
				v-for="(issue, index) in sorted"
				:key="`${issue.fingerprint}:${index}`"
				class="ng-issue"
				:clickable="isPickable(issue)"
				@click="pick(issue)"
			>
				<v-list-item-icon>
					<v-icon
						:name="issue.severity === 'error' ? 'error' : 'warning'"
						small
						:color="issue.severity === 'error' ? 'var(--theme--danger)' : 'var(--theme--warning)'"
					/>
				</v-list-item-icon>
				<v-list-item-content>
					<span class="ng-issue__message">{{ issue.message }}</span>
					<span v-if="elementText(issue)" class="ng-issue__element">{{ elementText(issue) }}</span>
				</v-list-item-content>
			</v-list-item>
		</template>

		<v-list-item v-else-if="emptyText" class="ng-issue ng-issue--none">
			<v-list-item-icon>
				<v-icon name="check_circle" small color="var(--theme--success)" />
			</v-list-item-icon>
			<v-list-item-content>
				<span class="ng-issue__none">{{ emptyText }}</span>
			</v-list-item-content>
		</v-list-item>
	</v-list>
</template>

<style scoped>
.ng-issue-list {
	--v-list-padding: 0;
	--v-list-min-width: 0;
	--v-list-item-padding: 0.4375rem 1rem;
	--v-list-item-margin: 0;
	--v-list-item-border-radius: 0;
	--v-list-background-color-hover: var(--theme--background-accent);
	--v-list-background-color-active: var(--theme--background-accent);

	overflow: visible;
}

.ng-issue {
	align-items: flex-start;
}

/*
 * Centre the 1rem icon on the first 1.25rem line of the message: the content
 * starts 0.25rem down (v-list-item-content.vue, non-nav lists), so the icon
 * starts at 0.25rem + (1.25rem - 1rem) / 2.
 */
.ng-issue :deep(.v-list-item-icon) {
	align-self: flex-start;
	margin-block: 0.375rem 0;
}

.ng-issue__message {
	display: -webkit-box;
	overflow: hidden;
	color: var(--theme--foreground);
	font-size: 0.8125rem;
	line-height: 1.25rem;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.ng-issue__element {
	overflow: hidden;
	color: var(--theme--foreground-subdued);
	font-size: 0.75rem;
	line-height: 1rem;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.ng-issue__none {
	color: var(--theme--foreground-subdued);
	font-size: 0.8125rem;
}
</style>
