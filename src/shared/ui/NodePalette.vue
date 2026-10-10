<script setup lang="ts">
/**
 * The palette in the drawer's `#sidebar` slot (docs/design.md §9.3): node types
 * grouped by category, in the drawer sidebar's navigation-list styling.
 *
 * The stock drawer maps the `--v-list-item-*` variables to the navigation
 * list tokens for whatever is in its sidebar
 * (directus-11.17.4/app/src/components/v-drawer.vue:187-219), so a plain
 * `v-list nav` looks like the settings navigation without extra CSS.
 *
 * Below 54rem the drawer hides the sidebar and renders the same slot again
 * inside a VDetail above the content (v-drawer.vue:127-131). The palette is
 * then mounted twice, so it must not use DOM ids or hold state that matters.
 */

import { computed, ref } from 'vue';
import type { CompiledRuleset, GraphDocument, NodeTypeDef } from '../core';
import { PALETTE_DRAG_MIME } from './canvas-contract';

const props = defineProps<{
	ruleset: CompiledRuleset;
	document: GraphDocument;
}>();

const emit = defineEmits<{
	add: [type: string];
}>();

interface PaletteEntry {
	type: NodeTypeDef;
	used: number;
	max: number | null;
	full: boolean;
	tooltip: string;
}

interface PaletteGroup {
	/** null for types without a category; they come first, without a heading. */
	category: string | null;
	entries: PaletteEntry[];
}

/** The content navigation adds its search above this many entries (docs/design.md §9.3). */
const SEARCH_THRESHOLD = 8;

const search = ref('');

const counts = computed(() => {
	const tally = new Map<string, number>();
	for (const node of props.document.nodes) tally.set(node.type, (tally.get(node.type) ?? 0) + 1);
	return tally;
});

/** Deprecated types are hidden: existing nodes stay valid, new ones cannot be added. */
const visibleTypes = computed(() => props.ruleset.nodeTypes.filter((type) => !type.deprecated));

const showSearch = computed(() => visibleTypes.value.length > SEARCH_THRESHOLD);

const groups = computed<PaletteGroup[]>(() => {
	const query = search.value.trim().toLowerCase();
	const result: PaletteGroup[] = [];
	const byCategory = new Map<string | null, PaletteGroup>();

	// Uncategorised types first, then categories in the order they first appear.
	byCategory.set(null, { category: null, entries: [] });
	result.push(byCategory.get(null)!);

	for (const type of visibleTypes.value) {
		if (query && !matches(type, query)) continue;

		const category = type.category?.trim() || null;
		let group = byCategory.get(category);

		if (!group) {
			group = { category, entries: [] };
			byCategory.set(category, group);
			result.push(group);
		}

		const used = counts.value.get(type.key) ?? 0;
		const max = type.limits?.maxInstances ?? null;
		// Like core's addNode: the limit only blocks while `max_instances` is an
		// error; at 'warning' or 'off' the server accepts the extra node, so the
		// palette offers it and the issues panel reports it.
		const full = max !== null && used >= max && props.ruleset.severities.max_instances === 'error';

		group.entries.push({
			type,
			used,
			max,
			full,
			tooltip: full ? `Limit reached (${used} of ${max})` : (type.description ?? ''),
		});
	}

	return result.filter((group) => group.entries.length > 0);
});

function matches(type: NodeTypeDef, query: string): boolean {
	return [type.label, type.key, type.category ?? '', type.description ?? ''].some((text) =>
		text.toLowerCase().includes(query),
	);
}

function onDragStart(event: DragEvent, entry: PaletteEntry) {
	if (entry.full || !event.dataTransfer) {
		event.preventDefault();
		return;
	}

	// Only the custom type: a text/plain payload would let the type key be
	// dropped into text inputs elsewhere on the page. The browser's default
	// drag image of the list item is kept (docs/design.md §9.3).
	event.dataTransfer.setData(PALETTE_DRAG_MIME, entry.type.key);
	event.dataTransfer.effectAllowed = 'copy';
}

function onClick(entry: PaletteEntry) {
	if (entry.full) return;
	emit('add', entry.type.key);
}
</script>

<template>
	<div class="node-graph-palette">
		<div v-if="showSearch" class="ng-palette-search">
			<v-input v-model="search" small type="search" placeholder="Search node types" aria-label="Search node types">
				<template #append>
					<v-icon name="search" small />
				</template>
			</v-input>
		</div>

		<v-notice v-if="visibleTypes.length === 0" class="ng-palette-empty">This ruleset has no node types to add.</v-notice>

		<div v-else-if="groups.length === 0" class="ng-palette-no-results">No node types match.</div>

		<v-list v-if="groups.length > 0" nav class="ng-palette-list">
			<template v-for="group in groups" :key="group.category ?? ''">
				<template v-if="group.category === null">
					<v-list-item
						v-for="entry in group.entries"
						:key="entry.type.key"
						v-tooltip.right="entry.tooltip || null"
						class="ng-palette-item"
						clickable
						:disabled="entry.full"
						:draggable="entry.full ? 'false' : 'true'"
						@click="onClick(entry)"
						@dragstart="onDragStart($event, entry)"
					>
						<v-list-item-icon>
							<v-icon :name="entry.type.icon || 'account_tree'" :color="entry.type.color" />
						</v-list-item-icon>
						<v-list-item-content>
							<v-text-overflow :text="entry.type.label" />
						</v-list-item-content>
						<v-list-item-hint v-if="entry.max !== null" class="ng-palette-hint">{{ entry.used }} / {{ entry.max }}</v-list-item-hint>
					</v-list-item>
				</template>

				<!-- A category is a v-detail group, as folders are in the content navigation (modules/content/components/navigation-item.vue) -->
				<v-detail v-else :label="group.category" start-open class="ng-palette-group">
					<v-list-item
						v-for="entry in group.entries"
						:key="entry.type.key"
						v-tooltip.right="entry.tooltip || null"
						class="ng-palette-item"
						clickable
						:disabled="entry.full"
						:draggable="entry.full ? 'false' : 'true'"
						@click="onClick(entry)"
						@dragstart="onDragStart($event, entry)"
					>
						<v-list-item-icon>
							<v-icon :name="entry.type.icon || 'category'" :color="entry.type.color" />
						</v-list-item-icon>
						<v-list-item-content>
							<v-text-overflow :text="entry.type.label" />
						</v-list-item-content>
						<v-list-item-hint v-if="entry.max !== null" class="ng-palette-hint">{{ entry.used }} / {{ entry.max }}</v-list-item-hint>
					</v-list-item>
				</v-detail>
			</template>
		</v-list>
	</div>
</template>

<style scoped>
/* Group spacing of the content navigation (modules/content/components/navigation.vue:118-136) */
.ng-palette-group :deep(.v-divider) {
	margin: 0;
}

.ng-palette-group:not(:first-child) :deep(.v-divider) {
	margin-block-start: 0.4375rem;
}

.ng-palette-hint {
	font-size: 0.75rem;
	font-variant-numeric: tabular-nums;
}

.ng-palette-empty {
	margin: 0.6875rem;
}

.ng-palette-no-results {
	padding: 0.6875rem 1.125rem;
	color: var(--theme--foreground-subdued);
}
</style>
