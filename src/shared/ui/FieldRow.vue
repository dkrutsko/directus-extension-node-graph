<script setup lang="ts">
/**
 * The field row in the item form: an input-like row in the style of the
 * stock M2O and File interfaces (docs/design.md §10). It only presents; the
 * interface component decides the state and handles `activate`.
 *
 * Markup copies the File interface row
 * (directus-11.17.4/app/src/interfaces/file/file.vue:221-283): a `block
 * clickable` VListItem with a 2.25rem preview tile, the text, and the
 * `item-actions` icons on the right. The whole row and the action icon do
 * the same thing, as on the M2O row
 * (interfaces/select-dropdown-m2o/select-dropdown-m2o.vue:197-205).
 */

import { computed } from 'vue';
import { useAppText } from './i18n';
import type { FieldRowAction } from './types';

const props = withDefaults(
	defineProps<{
		/** The form is still loading the item. */
		loading?: boolean;
		/** The field has a (possibly malformed) value. */
		hasValue: boolean;
		/** fieldSummary() of the value. */
		summary: string;
		placeholder: string;
		errorCount?: number;
		warningCount?: number;
		/** Normalisation repairs; non-empty means the stored value was malformed. */
		problems?: string[];
		/** What clicking does; null makes the row inert (empty and read-only). */
		action: FieldRowAction | null;
	}>(),
	{
		loading: false,
		errorCount: 0,
		warningCount: 0,
		problems: () => [],
	},
);

const emit = defineEmits<{
	activate: [];
}>();

const t = useAppText();

const malformed = computed(() => props.hasValue && props.problems.length > 0);

const actionIcon = computed(() => {
	if (props.action === 'view') return 'visibility';
	if (props.action === 'create') return 'add';
	return 'edit';
});

const actionLabel = computed(() => {
	if (props.action === 'view') return 'View';
	if (props.action === 'create') return t('create', 'Create');
	return t('edit', 'Edit');
});

const tileTooltip = computed(() => {
	if (!malformed.value) return null;
	return `The stored value was repaired when it was read:\n${props.problems.join('\n')}`;
});

function activate() {
	if (props.action === null) return;
	emit('activate');
}
</script>

<template>
	<div class="node-graph-field">
		<v-skeleton-loader v-if="loading" type="input" />

		<v-list-item
			v-else
			class="ng-field-row"
			:class="{ 'ng-field-row--view': action === 'view' }"
			block
			clickable
			:disabled="action === null"
			:non-editable="action === 'view'"
			@click="activate"
		>
			<v-list-item-icon>
				<div
					v-tooltip="tileTooltip"
					class="ng-field-icon"
					:class="{ 'ng-field-icon--filled': hasValue && !malformed, 'ng-field-icon--warning': malformed }"
				>
					<v-icon name="account_tree" />
				</div>
			</v-list-item-icon>

			<v-list-item-content>
				<v-text-overflow v-if="hasValue" class="ng-field-text" :text="summary" />
				<v-text-overflow v-else class="ng-field-placeholder" :text="placeholder" />
			</v-list-item-content>

			<div v-if="errorCount > 0 || warningCount > 0" class="ng-field-chips">
				<span
					v-if="errorCount > 0"
					v-tooltip="`${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`"
					class="ng-issue-chip ng-issue-chip--error"
				>
					<v-icon name="error" />
					{{ errorCount }}
				</span>
				<span
					v-if="warningCount > 0"
					v-tooltip="`${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`"
					class="ng-issue-chip ng-issue-chip--warning"
				>
					<v-icon name="warning" />
					{{ warningCount }}
				</span>
			</div>

			<div v-if="action" class="item-actions" @click.stop>
				<v-icon
					v-tooltip="actionLabel"
					:aria-label="actionLabel"
					:name="actionIcon"
					class="ng-field-action"
					:class="{ 'ng-field-action--add': action === 'create' }"
					clickable
					@click="activate"
				/>
			</div>
		</v-list-item>
	</div>
</template>

<style scoped>
.node-graph-field {
	position: relative;
}

/* Disabled and focus states of the M2O / File rows (select-dropdown-m2o.vue:306-321, file.vue:396-417) */
.ng-field-row.disabled:not(.non-editable) {
	--v-list-item-color: var(--theme--foreground-subdued);
	--v-list-item-background-color: var(--theme--form--field--input--background-subdued);
	--v-list-item-border-color: var(--v-input-border-color, var(--theme--form--field--input--border-color));
}

/*
 * "View": the field is read-only but the graph can still be opened, as a
 * non-editable M2O stays clickable. It keeps the read-only background so it
 * reads as not editable.
 */
.ng-field-row.ng-field-row--view {
	--v-list-item-background-color: var(--theme--form--field--input--background-subdued);
	--v-list-item-background-color-hover: var(--theme--form--field--input--background-subdued);
}

.ng-field-row:focus-within:not(.disabled),
.ng-field-row:focus-visible:not(.disabled) {
	--v-list-item-border-color: var(--v-input-border-color-focus, var(--theme--form--field--input--border-color-focus));
	--v-list-item-border-color-hover: var(--v-list-item-border-color);

	box-shadow: var(--theme--form--field--input--box-shadow-focus);
}

.ng-field-text {
	color: var(--theme--form--field--input--foreground);
}

.ng-field-row.disabled:not(.non-editable) .ng-field-text {
	color: var(--theme--form--field--input--foreground-subdued);
}

.ng-field-placeholder {
	color: var(--v-input-placeholder-color, var(--theme--foreground-subdued));
}

.ng-field-chips {
	display: flex;
	flex: none;
	gap: 0.25rem;
	align-items: center;
	margin-inline-start: 0.4375rem;
}

/* list-interface-item-actions (app/src/styles/mixins/_list-interface.scss:22-42) */
.item-actions {
	display: flex;
	flex: none;
	gap: 0.25rem;
	align-items: center;
	padding-inline-start: 0.4375rem;
}

.item-actions :deep(.v-icon) {
	--v-icon-color: var(--theme--form--field--input--foreground-subdued);
}

/* The M2O "create" icon turns primary on hover (select-dropdown-m2o.vue:296-298) */
.item-actions :deep(.ng-field-action--add) {
	--v-icon-color-hover: var(--theme--primary);
}
</style>
