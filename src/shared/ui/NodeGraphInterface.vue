<script setup lang="ts">
/**
 * The node-graph interface: the field row in the item form plus the editor
 * drawer, parameterised by a CanvasRegistration so nothing here depends on
 * the graph library (canvas-contract.ts).
 *
 * The form passes every interface option as a prop, next to the standard
 * interface props (directus-11.17.4/app/src/components/v-form/components/form-field-interface.vue:60-85).
 * Options and state are always read through computeds, never once at
 * setup, because the form changes them after mount: `disabled` is true
 * while the item loads (form-field.vue:67-73 and v-form's loading state),
 * the value arrives after mount, and a collaborator focusing the field
 * disables it (form-field.vue:65-73).
 *
 * States of the row (docs/design.md §10.2):
 *   loading          skeleton
 *   batch mode       notice, no editor
 *   invalid ruleset  danger notice with the problems, no editor
 *   empty            placeholder + "Create" (editable) or nothing (read-only)
 *   value            summary + issue chips + "Edit" or "View"
 *   malformed value  warning tile; the editor opens the normalised document
 */

import { computed, ref, shallowRef } from 'vue';
import {
	fieldSummary,
	normalizeDocument,
	starterDocument,
	validateValue,
	type GraphDocument,
	type Ruleset,
} from '../core';
import { formatTitle } from '../core/util';
import { resolveFieldOptions } from '../options';
import type { CanvasRegistration } from './canvas-contract';
import { valueSignature } from './documents';
import FieldRow from './FieldRow.vue';
import NodeGraphEditor from './NodeGraphEditor.vue';
import { getCompiledRuleset } from './ruleset-cache';
import type { EditorSession, FieldRowAction } from './types';
import './theme.css';

// Undeclared attributes (width, type, length, …) must not land on the root element.
defineOptions({ inheritAttrs: false });

const props = withDefaults(
	defineProps<{
		/** The interface id and the canvas component. Passed by the interface entry. */
		registration: CanvasRegistration;

		/* Standard interface props (form-field-interface.vue:60-85) */
		value?: unknown;
		disabled?: boolean;
		nonEditable?: boolean;
		loading?: boolean;
		batchMode?: boolean;
		batchActive?: boolean;
		comparisonMode?: boolean;
		collection?: string | null;
		field?: string | null;
		fieldData?: { name?: string | null; field?: string | null } | null;
		primaryKey?: string | number | null;
		direction?: string | null;

		/* Interface options (../options.ts), raw; resolved through resolveFieldOptions() */
		ruleset?: Ruleset | string | null;
		template?: string | null;
		placeholder?: string | null;
		editorWidth?: string | null;
		enforcement?: string | null;
		snapToGrid?: boolean | null;
		gridSize?: number | null;
		showMinimap?: boolean | null;
	}>(),
	{
		// `value` has no default: it is `unknown` (any JSON, or a string from the API), and undefined counts as empty.
		disabled: false,
		nonEditable: false,
		loading: false,
		batchMode: false,
		batchActive: false,
		comparisonMode: false,
		collection: null,
		field: null,
		fieldData: null,
		primaryKey: null,
		direction: null,
		ruleset: null,
		template: null,
		placeholder: null,
		editorWidth: null,
		enforcement: null,
		snapToGrid: null,
		gridSize: null,
		showMinimap: null,
	},
);

const emit = defineEmits<{
	input: [value: GraphDocument | null];
}>();

/* Options and ruleset ----------------------------------------------------- */

const options = computed(() =>
	resolveFieldOptions({
		ruleset: props.ruleset,
		template: props.template,
		placeholder: props.placeholder,
		editorWidth: props.editorWidth,
		enforcement: props.enforcement,
		snapToGrid: props.snapToGrid,
		gridSize: props.gridSize,
		showMinimap: props.showMinimap,
	}),
);

const compiled = computed(() => getCompiledRuleset(options.value.ruleset));
const ruleset = computed(() => compiled.value.ruleset);

/* Value ------------------------------------------------------------------- */

const hasValue = computed(() => props.value !== null && props.value !== undefined && props.value !== '');

/** Normalised and validated in one step; data that normalisation dropped shows up as invalid_document issues. */
const report = computed(() => validateValue(ruleset.value, props.value));

const errorCount = computed(() => report.value.issues.filter((issue) => issue.severity === 'error').length);
const warningCount = computed(() => report.value.issues.length - errorCount.value);

const summary = computed(() =>
	fieldSummary({ template: options.value.template }, ruleset.value, report.value.document, report.value.issues),
);

/* Mode -------------------------------------------------------------------- */

/** A read-only field, an archived or locked item, missing update permission, a collaborator's focus. */
const readOnly = computed(() => props.disabled || props.nonEditable);

const action = computed<FieldRowAction | null>(() => {
	if (props.loading) return null;
	if (hasValue.value) return readOnly.value ? 'view' : 'edit';
	return readOnly.value ? null : 'create';
});

const title = computed(() => {
	const name = props.fieldData?.name;
	if (typeof name === 'string' && name.trim() !== '') return name;
	return props.field ? formatTitle(props.field) : 'Graph';
});

/* Editor ------------------------------------------------------------------ */

const editorOpen = ref(false);
const session = shallowRef<EditorSession | null>(null);

/*
 * The mode an open editor started in. The form marks every field disabled
 * while it reloads the item (form-field.vue:67-73; a collaborator's save
 * triggers a reload, app/src/composables/use-collab.ts:468-470), and that
 * must not flip an open editor to read-only and back. The open editor holds
 * the field's collaborative-editing lock, so no one else can take it meanwhile.
 */
const openedReadOnly = ref(false);
const editorReadOnly = computed(() => (editorOpen.value ? openedReadOnly.value : readOnly.value));

function activate() {
	const current = ruleset.value;
	if (!current || action.value === null) return;

	openedReadOnly.value = readOnly.value;

	if (action.value === 'create') {
		session.value = {
			document: starterDocument(current),
			source: valueSignature(props.value),
			created: true,
			repaired: false,
		};
	} else {
		const { document, problems } = normalizeDocument(props.value);

		session.value = {
			document,
			source: valueSignature(props.value),
			created: false,
			repaired: problems.length > 0,
		};
	}

	editorOpen.value = true;
}

function onApply(document: GraphDocument) {
	emit('input', document);
}
</script>

<template>
	<!--
		v-prevent-focusout keeps focus "inside" the field while the drawer is
		open: the drawer is teleported out of the form, and losing focus would
		release the field's collaborative-editing lock (form-field.vue:271-272).
		The stock relational interfaces do the same (interfaces/list/list.vue:222).
	-->
	<div v-prevent-focusout="editorOpen" class="node-graph-interface" :data-node-graph="registration.interfaceId">
		<v-notice v-if="batchMode" class="ng-interface-notice">Batch editing is not supported for node graphs.</v-notice>

		<v-skeleton-loader v-else-if="loading" type="input" />

		<!--
			A #title with content below: `multiline indent-content`, like the stock
			validation notices (interfaces/_system/system-mcp-prompts-collection-validation/
			system-mcp-prompts-collection-validation-existing.vue:22-51). A missing
			ruleset gets a short hint instead of a one-item problem list that would
			only repeat the title.
		-->
		<v-notice v-else-if="!ruleset" type="danger" class="ng-interface-notice ng-ruleset-notice" multiline indent-content>
			<template #title>
				{{ options.ruleset === null ? 'This field has no ruleset' : "This field's ruleset is invalid" }}
			</template>
			<div class="ng-notice-content">
				<ul v-if="options.ruleset !== null" class="ng-ruleset-problems">
					<li v-for="(problem, index) in compiled.problems.slice(0, 20)" :key="index">{{ problem }}</li>
					<li v-if="compiled.problems.length > 20">…and {{ compiled.problems.length - 20 }} more.</li>
				</ul>
				<p v-else>An administrator can set one in the field's interface options in Data Model.</p>
			</div>
		</v-notice>

		<field-row
			v-else
			:has-value="hasValue"
			:summary="summary"
			:placeholder="options.placeholder ?? 'No graph yet'"
			:error-count="errorCount"
			:warning-count="warningCount"
			:problems="report.problems"
			:action="action"
			@activate="activate"
		/>

		<!--
			Outside the chain above, so that reloading the item does not unmount an
			open editor. The item page sets every field to `loading` while it
			refetches (app/src/composables/use-item/index.ts:131-145), which a
			collaborator's save does while the drawer is open; inside the chain the
			skeleton replaced the editor, its unapplied edits were lost, and it came
			back from the stale session without the remote-change banner.
		-->
		<node-graph-editor
			v-if="ruleset"
			v-model:open="editorOpen"
			:session="session"
			:ruleset="ruleset"
			:options="options"
			:read-only="editorReadOnly"
			:title="title"
			:registration="registration"
			:value="value"
			:direction="direction ?? undefined"
			@apply="onApply"
		/>
	</div>
</template>

<style scoped>
/*
 * The content always starts on its own line under the title. VNotice only
 * wraps it there when it is too wide to sit beside the title (`.multiline` is
 * `flex-wrap: wrap`, directus-11.17.4/app/src/components/v-notice.vue:146-148),
 * so a short message ended up to the right of the title.
 */
.ng-ruleset-notice :deep(.v-notice-content) {
	flex-basis: 100%;
}

/* The spacing of the stock validation notices (system-mcp-prompts-collection-validation-existing.vue:83-88) */
.ng-notice-content {
	display: flex;
	flex-direction: column;
	gap: 0.5625rem;
	padding-block: 0.5625rem 0.25rem;
}

.ng-notice-content p {
	margin: 0;
}

.ng-ruleset-problems {
	margin: 0;
	padding-inline-start: 1.125rem;
	font-family: var(--theme--fonts--monospace--font-family);
	font-size: 0.8125rem;
}
</style>
