<script setup lang="ts">
/**
 * The inspector: the upper section of the editor's right-hand column
 * (docs/design.md §9.5). It shows what is selected:
 *
 * - a node: its icon, type and title, a delete button, the node type's
 *   fields in the app's global `v-form`, and the node's issues;
 * - a connection: its type (limited to what the source port allows), the
 *   edge type's fields, and its issues;
 * - several elements: a count and a delete button;
 * - nothing: the ruleset, counts and a few hints.
 *
 * Field edits become `updateNodeData` / `updateEdge` commands; the inspector
 * never changes the document itself.
 */

import { computed, inject } from 'vue';
import {
	edgeLabel,
	fieldDefaults,
	formatValue,
	getPorts,
	nodeTitle,
	type CompiledRuleset,
	type GraphCommand,
	type GraphDocument,
	type GraphEdge,
	type GraphNode,
	type Issue,
	type ReferenceResolver,
} from '../core';
import type { Selection } from './canvas-contract';
import { formPatch, toFormFields, type FormFieldDefinition } from './form-fields';
import IssueList from './IssueList.vue';
import { shortcutLabel } from './platform';
import { useAppText } from './i18n';
import { REFERENCE_LABELS } from './references';

const props = defineProps<{
	ruleset: CompiledRuleset;
	document: GraphDocument;
	/** The document as it was when the editor opened (or last applied); drives v-form's "edited" marks. */
	baseline: GraphDocument;
	selection: Selection | null;
	issues: Issue[];
	readOnly: boolean;
	direction?: string | undefined;
}>();

const emit = defineEmits<{
	command: [command: GraphCommand];
	/** Delete everything that is selected. */
	delete: [];
	pick: [issue: Issue];
}>();

const t = useAppText();

/*
 * Display text of item references, provided by the editor (references.ts).
 * Reading `.value` where the text is computed re-renders it when labels
 * arrive; without a provider references show their keys.
 */
const referenceLabels = inject(REFERENCE_LABELS, null);
const references = (): ReferenceResolver | undefined => referenceLabels?.value.resolve;

/* Selection --------------------------------------------------------------- */

const selectedNodes = computed<GraphNode[]>(() => {
	if (props.selection?.kind !== 'node') return [];
	const ids = new Set(props.selection.ids);
	return props.document.nodes.filter((node) => ids.has(node.id));
});

const selectedEdges = computed<GraphEdge[]>(() => {
	if (props.selection?.kind !== 'edge') return [];
	const ids = new Set(props.selection.ids);
	return props.document.edges.filter((edge) => ids.has(edge.id));
});

const count = computed(() => selectedNodes.value.length + selectedEdges.value.length);

const mode = computed<'none' | 'node' | 'edge' | 'many'>(() => {
	if (count.value === 0) return 'none';
	if (count.value > 1) return 'many';
	return selectedNodes.value.length === 1 ? 'node' : 'edge';
});

const node = computed(() => (mode.value === 'node' ? selectedNodes.value[0]! : null));
const edge = computed(() => (mode.value === 'edge' ? selectedEdges.value[0]! : null));

/* Node -------------------------------------------------------------------- */

const nodeType = computed(() => (node.value ? (props.ruleset.nodeTypeMap.get(node.value.type) ?? null) : null));

const nodeFields = computed<FormFieldDefinition[]>(() => toFormFields(nodeType.value?.fields));

/** Unknown types can always be removed (applyCommand agrees, core/commands.ts). */
function isNodeDeletable(candidate: GraphNode): boolean {
	const type = props.ruleset.nodeTypeMap.get(candidate.type);
	return !type || type.deletable !== false;
}

const nodeInitialValues = computed<Record<string, unknown> | null>(() => {
	if (!node.value) return null;
	const before = props.baseline.nodes.find((candidate) => candidate.id === node.value!.id);
	return before ? before.data : fieldDefaults(nodeType.value?.fields);
});

function onNodeForm(values: unknown) {
	if (!node.value || props.readOnly) return;

	const patch = formPatch(values, node.value.data, nodeInitialValues.value, nodeFields.value);
	if (patch) emit('command', { kind: 'updateNodeData', id: node.value.id, data: patch });
}

/** Raw data of a node whose type the ruleset does not know, shown read-only. */
const unknownData = computed(() => {
	if (!node.value || nodeType.value) return [];
	return Object.entries(node.value.data).map(([key, value]) => ({ key, value: formatValue(value, undefined, false, references()) }));
});

/* Edge -------------------------------------------------------------------- */

const edgeTypeKey = computed(() => (edge.value ? (edge.value.type ?? props.ruleset.defaultEdgeType) : null));
const edgeType = computed(() => (edgeTypeKey.value ? (props.ruleset.edgeTypeMap.get(edgeTypeKey.value) ?? null) : null));
const edgeFields = computed<FormFieldDefinition[]>(() => toFormFields(edgeType.value?.fields));

const edgeEndpoints = computed(() => {
	if (!edge.value) return null;
	const source = props.document.nodes.find((candidate) => candidate.id === edge.value!.source) ?? null;
	const target = props.document.nodes.find((candidate) => candidate.id === edge.value!.target) ?? null;
	return { source, target };
});

const edgeTitle = computed(() => {
	if (!edge.value || !edgeEndpoints.value) return '';
	const { source, target } = edgeEndpoints.value;
	const from = source ? nodeTitle(props.ruleset, source, references()) : edge.value.source;
	const to = target ? nodeTitle(props.ruleset, target, references()) : edge.value.target;
	return `${from} → ${to}`;
});

/** Edge types the source port allows (its `edgeTypes`, default first): the only types the edge may switch to. */
const edgeTypeChoices = computed(() => {
	if (!edge.value || !edgeEndpoints.value) return [];

	const source = edgeEndpoints.value.source;
	let keys: string[] = [];

	if (source) {
		const port = getPorts(props.ruleset, source, props.document.edges).outputs.find(
			(candidate) => candidate.key === edge.value!.sourceHandle,
		);

		if (port) keys = port.edgeTypes;
	}

	// An unknown source or port: offer only the current type, so the select never invents a change.
	if (keys.length === 0 && edgeTypeKey.value) keys = [edgeTypeKey.value];

	return keys.map((key) => ({ text: props.ruleset.edgeTypeMap.get(key)?.label ?? key, value: key }));
});

const edgeInitialValues = computed<Record<string, unknown> | null>(() => {
	if (!edge.value) return null;
	const before = props.baseline.edges.find((candidate) => candidate.id === edge.value!.id);
	return before && (before.type ?? props.ruleset.defaultEdgeType) === edgeTypeKey.value
		? (before.data ?? {})
		: fieldDefaults(edgeType.value?.fields);
});

function onEdgeType(type: unknown) {
	if (!edge.value || props.readOnly || typeof type !== 'string' || type === edgeTypeKey.value) return;
	emit('command', { kind: 'updateEdge', id: edge.value.id, type });
}

function onEdgeForm(values: unknown) {
	if (!edge.value || props.readOnly) return;

	const patch = formPatch(values, edge.value.data ?? {}, edgeInitialValues.value, edgeFields.value);
	if (patch) emit('command', { kind: 'updateEdge', id: edge.value.id, data: patch });
}

/* Issues and deletion ----------------------------------------------------- */

const elementIssues = computed(() => {
	if (node.value) return props.issues.filter((issue) => issue.nodeId === node.value!.id && !issue.edgeId);
	if (edge.value) return props.issues.filter((issue) => issue.edgeId === edge.value!.id);
	return [];
});

const canDelete = computed(() => {
	if (props.readOnly || count.value === 0) return false;
	return selectedNodes.value.every(isNodeDeletable);
});

const stats = computed(() => {
	let errors = 0;
	let warnings = 0;

	for (const issue of props.issues) {
		if (issue.severity === 'error') errors++;
		else warnings++;
	}

	return [
		{ label: 'Nodes', value: props.document.nodes.length },
		{ label: 'Connections', value: props.document.edges.length },
		{ label: 'Errors', value: errors },
		{ label: 'Warnings', value: warnings },
	];
});

const deleteLabel = computed(() => t('delete_label', 'Delete'));

/** "2 nodes and 1 connection selected." for the multiple-selection section. */
const manySummary = computed(() => {
	const nodes = selectedNodes.value.length;
	const edges = selectedEdges.value.length;
	const parts: string[] = [];

	if (nodes > 0) parts.push(`${nodes} ${nodes === 1 ? 'node' : 'nodes'}`);
	if (edges > 0) parts.push(`${edges} ${edges === 1 ? 'connection' : 'connections'}`);

	return `${parts.join(' and ')} selected.`;
});

const help = computed(() => {
	if (props.readOnly) return ['Select a node or connection to see its details.', 'Scroll or pinch to zoom; drag the background to pan.'];

	return [
		'Drag from a port to another node to connect.',
		'Delete or Backspace removes the selection.',
		`${shortcutLabel(['meta', 'z'])} undoes, ${shortcutLabel(['meta', 'shift', 'z'])} redoes, ${shortcutLabel(['meta', 's'])} applies and keeps the editor open.`,
	];
});

const edgeLabelText = computed(() => (edge.value ? edgeLabel(props.ruleset, edge.value, references()) : ''));

const nodeTitleText = computed(() => (node.value ? nodeTitle(props.ruleset, node.value, references()) : ''));
</script>

<template>
	<section class="ng-inspector">
		<!-- One node -->
		<template v-if="node">
			<header class="ng-panel-header">
				<v-icon
					:name="nodeType ? nodeType.icon || (nodeType.category ? 'category' : 'account_tree') : 'help'"
					:color="nodeType ? nodeType.color || 'var(--theme--primary)' : 'var(--theme--danger)'"
				/>
				<div class="ng-panel-header__title ng-inspector__heading">
					<span class="ng-inspector__type">
						{{ nodeType ? nodeType.label : 'Unknown type' }}
						<em v-if="nodeType?.deprecated">· Deprecated</em>
					</span>
					<span class="ng-inspector__title" :class="{ 'ng-inspector__title--mono': !nodeType }">
						{{ nodeTitleText }}
					</span>
				</div>
				<v-icon
					v-if="canDelete"
					v-tooltip="deleteLabel"
					:aria-label="deleteLabel"
					class="ng-inspector__delete"
					name="delete"
					clickable
					@click="emit('delete')"
				/>
			</header>

			<div class="ng-panel-body ng-inspector__body">
				<template v-if="nodeType">
					<!-- Notices without a #title are not `multiline`, which would put the icon on a line of its own (v-notice.vue:146-148) -->
					<v-notice v-if="nodeType.deprecated" type="warning">
						This node type is deprecated. It still works, but new ones cannot be added.
					</v-notice>

					<v-form
						v-if="nodeFields.length > 0"
						:key="node.id"
						:fields="nodeFields"
						:model-value="node.data"
						:initial-values="nodeInitialValues"
						:disabled="readOnly"
						:direction="direction"
						:show-no-visible-fields="false"
						primary-key="+"
						@update:model-value="onNodeForm"
					/>

					<!-- Plain sidebar text like the help below, not an italic field note -->
					<div v-else class="ng-inspector__help"><p>This node type has no fields.</p></div>
				</template>

				<template v-else>
					<v-notice type="danger">
						The ruleset has no node type “{{ node.type }}”. The node is kept as it is, so nothing is lost; delete it or add the type to the ruleset.
					</v-notice>

					<dl v-if="unknownData.length > 0" class="ng-inspector__raw">
						<div v-for="entry in unknownData" :key="entry.key">
							<dt>{{ entry.key }}</dt>
							<dd>{{ entry.value }}</dd>
						</div>
					</dl>
				</template>

				<div v-if="elementIssues.length > 0" class="ng-inspector__issues">
					<p class="type-label ng-inspector__subheading">Issues</p>
					<issue-list
						:issues="elementIssues"
						:ruleset="ruleset"
						:document="document"
						:show-element="false"
						:empty-text="null"
					/>
				</div>
			</div>
		</template>

		<!-- One connection -->
		<template v-else-if="edge">
			<header class="ng-panel-header">
				<v-icon name="trending_flat" :color="edgeType?.style?.color || undefined" />
				<div class="ng-panel-header__title ng-inspector__heading">
					<span class="ng-inspector__type">{{ edgeType?.label ?? 'Connection' }}</span>
					<span class="ng-inspector__title">{{ edgeTitle }}</span>
				</div>
				<v-icon
					v-if="canDelete"
					v-tooltip="deleteLabel"
					:aria-label="deleteLabel"
					class="ng-inspector__delete"
					name="delete"
					clickable
					@click="emit('delete')"
				/>
			</header>

			<div class="ng-panel-body ng-inspector__body">
				<div v-if="edgeTypeChoices.length > 1" class="ng-inspector__field">
					<p class="type-label ng-inspector__label">Type</p>
					<v-select
						:model-value="edgeTypeKey"
						:items="edgeTypeChoices"
						:disabled="readOnly"
						@update:model-value="onEdgeType"
					/>
				</div>

				<v-form
					v-if="edgeFields.length > 0"
					:key="`${edge.id}:${edgeTypeKey}`"
					:fields="edgeFields"
					:model-value="edge.data ?? {}"
					:initial-values="edgeInitialValues"
					:disabled="readOnly"
					:direction="direction"
					:show-no-visible-fields="false"
					primary-key="+"
					@update:model-value="onEdgeForm"
				/>

				<div v-else-if="edgeTypeChoices.length <= 1" class="ng-inspector__help">
					<p>{{ edgeLabelText ? `Label: ${edgeLabelText}` : 'This connection type has no fields.' }}</p>
				</div>

				<div v-if="elementIssues.length > 0" class="ng-inspector__issues">
					<p class="type-label ng-inspector__subheading">Issues</p>
					<issue-list
						:issues="elementIssues"
						:ruleset="ruleset"
						:document="document"
						:show-element="false"
						:empty-text="null"
					/>
				</div>
			</div>
		</template>

		<!--
			Several elements. Delete is the same header icon as for one element: a
			secondary v-button would be background-normal on the background-normal
			column and read as bare text.
		-->
		<template v-else-if="mode === 'many'">
			<header class="ng-panel-header">
				<v-icon name="select_all" />
				<div class="ng-panel-header__title">{{ count }} items selected</div>
				<v-icon
					v-if="canDelete"
					v-tooltip="deleteLabel"
					:aria-label="deleteLabel"
					class="ng-inspector__delete"
					name="delete"
					clickable
					@click="emit('delete')"
				/>
			</header>

			<div class="ng-panel-body ng-inspector__body">
				<div class="ng-inspector__help">
					<p>{{ manySummary }} Select a single element to edit its fields.</p>
					<p v-if="!canDelete && !readOnly">Some of the selected nodes cannot be deleted.</p>
				</div>
			</div>
		</template>

		<!--
			Nothing selected: the item sidebar's "Information" detail
			(modules/files/components/file-info-sidebar-detail.vue): groups of
			global dt/dd rows split by a v-divider, then the help as plain
			paragraphs, like the page descriptions in sidebars
			(modules/settings/routes/data-model/collections/collections.vue:280).
			The header names the ruleset once, in the same type-over-title stack
			as a selected node or connection.
		-->
		<template v-else>
			<header class="ng-panel-header">
				<v-icon name="account_tree" />
				<div class="ng-panel-header__title ng-inspector__heading">
					<span class="ng-inspector__type">Ruleset</span>
					<span class="ng-inspector__title">{{ ruleset.name }}</span>
				</div>
			</header>

			<div class="ng-panel-body ng-inspector__body ng-inspector__body--info">
				<dl class="ng-inspector__stats">
					<div>
						<dt>Key</dt>
						<dd>{{ ruleset.key }}</dd>
					</div>
					<div>
						<dt>Version</dt>
						<dd>{{ ruleset.version }}</dd>
					</div>
				</dl>

				<v-divider />

				<dl class="ng-inspector__stats">
					<div v-for="stat in stats" :key="stat.label">
						<dt>{{ stat.label }}</dt>
						<dd>{{ stat.value }}</dd>
					</div>
				</dl>

				<v-divider />

				<div class="ng-inspector__help">
					<p v-for="line in help" :key="line">{{ line }}</p>
				</div>
			</div>
		</template>
	</section>
</template>

<style scoped>
.ng-inspector {
	display: flex;
	flex-direction: column;
	min-block-size: 0;
}

.ng-inspector__heading {
	display: flex;
	flex-direction: column;
	justify-content: center;
}

/* The drawer header headline idiom (v-drawer-header.vue:146-154) */
.ng-inspector__type {
	overflow: hidden;
	color: var(--theme--foreground-subdued);
	font-weight: 600;
	font-size: 0.6875rem;
	line-height: 1rem;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.ng-inspector__title {
	overflow: hidden;
	color: var(--theme--foreground-accent);
	font-weight: 600;
	font-size: 0.875rem;
	line-height: 1.25rem;
	white-space: nowrap;
	text-overflow: ellipsis;
}

.ng-inspector__title--mono {
	font-family: var(--theme--fonts--monospace--font-family);
}

.ng-inspector__delete {
	--v-icon-color: var(--theme--foreground-subdued);
	--v-icon-color-hover: var(--theme--danger);

	margin-inline-end: 0.5rem;
}

/*
 * The body scrolls on its own under the fixed section header, like an open
 * sidebar-detail (views/private/components/sidebar-detail.vue:117), so a long form
 * (a Condition with many branches, or the stacked layout of a narrow drawer)
 * is never clipped by the column or painted over the issues section.
 */
.ng-inspector__body {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	gap: 1.375rem;
	min-block-size: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
}

/* Groups of the information section sit 1.125rem from their dividers, as in the stock info sidebars (file-info-sidebar-detail.vue, `.v-divider { margin: 1.125rem 0 }`) */
.ng-inspector__body--info {
	gap: 1.125rem;
}

/*
 * VDivider is `flex: 1 1 0` for use in rows (v-divider.vue:40); in this
 * column it must not take the free height. Its default colour, the input
 * border, equals the sidebar background in the dark theme (#21262e), so it
 * would vanish; use the divider Directus draws on that same background in
 * the navigation (packages/themes/src/themes/dark/default.ts:116-119).
 */
.ng-inspector__body > .v-divider {
	--v-divider-color: var(--theme--navigation--list--divider--border-color, var(--theme--border-color-accent));

	flex: none;
}

.ng-inspector__label {
	margin-block-end: 0.5rem;
}

.ng-inspector__subheading {
	margin-block-end: 0.25rem;
}

/* The issue rows run to the panel edges, like sidebar list items */
.ng-inspector__issues :deep(.ng-issue-list) {
	margin-inline: -1rem;
}

.ng-inspector__stats {
	margin: 0;
}

.ng-inspector__stats > div:last-child {
	margin-block-end: 0;
}

.ng-inspector__raw {
	margin: 0;
	font-family: var(--theme--fonts--monospace--font-family);
}

/* Plain text like a sidebar page description (modules/settings/routes/data-model/collections/collections.vue:280), not italic notes */
.ng-inspector__help {
	display: flex;
	flex-direction: column;
	gap: 0.4375rem;
	color: var(--theme--foreground);
}

.ng-inspector__help p {
	margin: 0;
}
</style>
