<script setup lang="ts">
/**
 * The editor surface: a widened stock VDrawer (docs/design.md §9), the same
 * component the Repeater opens for its items
 * (directus-11.17.4/app/src/interfaces/list/list.vue:280-315). A drawer is
 * how Directus edits nested content (Repeater, M2A, O2M): it brings the
 * familiar X and check, its sidebar slot makes a natural palette, and inside
 * an M2A item drawer it simply stacks. The price is the unscoped width rule
 * at the end of this file, keyed on the drawer's internal class names.
 *
 * - `#sidebar`: the node palette (edit mode only).
 * - `#actions`: undo, redo, zoom out, zoom in, fit, the issues toggle and the
 *   check button (read-only: zoom and fit only).
 * - default slot: the canvas (the library-specific component from the
 *   CanvasRegistration) with the shell's overlays, and the inspector /
 *   issues column; plus the two confirmation dialogs.
 *
 * The editor owns the working copy of the graph and its undo history. The
 * canvas only ever receives the current document and sends commands back
 * (canvas-contract.ts). Nothing reaches the form until Apply, which emits the
 * whole document once, exactly like the Repeater stages an item; the user
 * still saves the item afterwards.
 *
 * The component stays mounted while the field is on screen and the drawer
 * opens and closes through `open` (as the Repeater keeps its VDrawer in the
 * template). That matters for two app internals:
 *
 * - Teleport anchors: VDialog teleports into `#dialog-outlet`, and Vue 3.5
 *   appends a Teleport's anchors to its target when the Teleport *mounts*,
 *   not when its content opens (runtime-core Teleport.ts `prepareAnchor`).
 *   Overlays with the same z-index (stacked drawers, keep-behind dialogs)
 *   are ordered by that DOM position, so overlays declared inside the
 *   drawer's slot mount after the drawer and stack above it, where a sibling
 *   declared before it would open hidden behind it.
 * - Shortcut queues: VDialog registers Escape / ⌘⏎ / ⌘S through useShortcut at
 *   mount, newest first (directus-11.17.4/packages/composables/src/use-shortcut.ts:57-67).
 */

import { computed, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue';
import {
	applyCommand,
	canConnect,
	generateId,
	normalizeDocument,
	validateDocument,
	type CompiledRuleset,
	type GraphCommand,
	type GraphDocument,
	type Issue,
	type Position,
} from '../core';
import type { ResolvedFieldOptions } from '../options';
import type { CanvasExpose, CanvasRegistration, Selection } from './canvas-contract';
import { documentSignature, hasGraphChanges, prepareForApply, sameViewport, valueSignature } from './documents';
import { useGraphHistory } from './history';
import { useAppText } from './i18n';
import IssueList from './IssueList.vue';
import NodeInspector from './NodeInspector.vue';
import NodePalette from './NodePalette.vue';
import { hasModifier, isEditableTarget, isMenuOpen, shortcutLabel } from './platform';
import { REFERENCE_LABELS, useReferenceLabels } from './references';
import type { EditorSession } from './types';

const props = withDefaults(
	defineProps<{
		open: boolean;
		session: EditorSession | null;
		ruleset: CompiledRuleset;
		options: ResolvedFieldOptions;
		readOnly: boolean;
		/** Drawer title: the field name. */
		title: string;
		registration: CanvasRegistration;
		/** The field's current raw value, watched for changes made elsewhere while the editor is open. */
		value: unknown;
		direction?: string | undefined;
	}>(),
	{
		direction: undefined,
	},
);

const emit = defineEmits<{
	'update:open': [open: boolean];
	/** The document to stage in the form (normalised, with `meta` and the ruleset stamp). */
	apply: [document: GraphDocument];
}>();

const t = useAppText();

/** The card geometry of docs/design.md §5.1, used to centre a node added by clicking the palette. */
const NODE_WIDTH = 252;
const NODE_HEADER_HEIGHT = 54;
/** How long a connection-rejected toast stays (docs/design.md §4.2). */
const TOAST_DURATION = 4000;
/** If a canvas never reports `ready`, stop covering it after this long. */
const READY_TIMEOUT = 5000;
/** Keystrokes into the same inspector field within this window are one undo step. */
const TYPING_WINDOW = 1000;

/* State ------------------------------------------------------------------- */

const history = useGraphHistory(normalizeDocument(null).document);
const graph = history.document;
const canUndo = history.canUndo;
const canRedo = history.canRedo;

/** The document as it was opened or last applied: "unapplied changes" are relative to it. */
const baseline = shallowRef<GraphDocument>(graph.value);
/** Signature of the field value the editor considers itself in sync with. */
let sourceSignature = '';
let created = false;
let repaired = false;

const selection = shallowRef<Selection | null>(null);
const issuesOpen = ref(true);
const ready = ref(false);
const toast = shallowRef<{ type: 'danger' | 'info'; text: string } | null>(null);
const remote = shallowRef<{ value: unknown; signature: string } | null>(null);
const confirmDiscard = ref(false);
const confirmApply = shallowRef<{ stay: boolean; errors: number } | null>(null);

/** Unique per editor instance (canvas-contract.ts `instanceId`): library instance ids, DOM ids. */
const instanceId = generateId('ng');

const rootRef = ref<HTMLElement | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const canvasRef = ref<Partial<CanvasExpose> | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | null = null;
let readyTimer: ReturnType<typeof setTimeout> | null = null;

/*
 * Display text of item references in node and edge data (references.ts),
 * loaded only while the drawer is open. The inspector and the issue lists
 * inject it; the canvas gets it as a prop (canvas-contract.ts).
 */
const referenceLabels = useReferenceLabels({
	document: graph,
	ruleset: computed(() => props.ruleset),
	active: computed(() => props.open),
	logPrefix: `[${props.registration.interfaceId}]`,
});

provide(REFERENCE_LABELS, referenceLabels);

/*
 * Validation runs when nodes or edges change, not on every pan and zoom
 * (setViewport replaces the document object but keeps both arrays,
 * core/commands.ts). Returning the same array keeps everything that depends
 * on `issues`, the canvas included, from updating needlessly. Messages name
 * node titles, which can show item references, so arriving labels count as
 * a change too.
 */
let validated: { ruleset: CompiledRuleset; nodes: unknown; edges: unknown; labels: unknown; issues: Issue[] } | null = null;

const issues = computed<Issue[]>(() => {
	const document = graph.value;
	const labels = referenceLabels.value;

	if (
		validated &&
		validated.ruleset === props.ruleset &&
		validated.nodes === document.nodes &&
		validated.edges === document.edges &&
		validated.labels === labels
	) {
		return validated.issues;
	}

	const result = validateDocument(props.ruleset, document, { references: labels.resolve });
	validated = { ruleset: props.ruleset, nodes: document.nodes, edges: document.edges, labels, issues: result };
	return result;
});
const errorCount = computed(() => issues.value.filter((issue) => issue.severity === 'error').length);
const warningCount = computed(() => issues.value.length - errorCount.value);

const zoomPercent = computed(() => Math.round((graph.value.viewport?.zoom ?? 1) * 100));

const subtitle = computed(() => {
	const base = `${props.ruleset.name} · v${props.ruleset.version}`;
	return props.readOnly ? `${base} · Read Only` : base;
});

/* Opening and loading ----------------------------------------------------- */

watch(
	[() => props.open, () => props.session],
	([open, session], [wasOpen, previousSession]) => {
		if (open && session && (!wasOpen || session !== previousSession)) load(session);
		if (!open) teardown();
	},
);

// The editor can be mounted already open (the interface may render it lazily).
if (props.open && props.session) load(props.session);

function load(session: EditorSession) {
	history.reset(session.document);
	baseline.value = session.document;
	sourceSignature = session.source;
	created = session.created;
	repaired = session.repaired;

	selection.value = null;
	remote.value = null;
	confirmDiscard.value = false;
	confirmApply.value = null;
	clearToast();

	ready.value = false;
	if (readyTimer) clearTimeout(readyTimer);

	readyTimer = setTimeout(() => {
		if (!ready.value) {
			// eslint-disable-next-line no-console
			console.warn(`[${props.registration.interfaceId}] the canvas did not report "ready" within ${READY_TIMEOUT} ms`);
			ready.value = true;
		}
	}, READY_TIMEOUT);
}

function teardown() {
	clearToast();
	if (readyTimer) clearTimeout(readyTimer);
	readyTimer = null;
}

onBeforeUnmount(() => {
	teardown();
	detachRoot();
});

function onReady() {
	ready.value = true;
	if (readyTimer) clearTimeout(readyTimer);
	readyTimer = null;
}

/* Remote changes ----------------------------------------------------------- */

/*
 * If the field value changes while the editor is open (a collaborator saved
 * the item, which makes the item page reload it) and differs from what the
 * editor opened with, a banner offers Reload and Keep Mine instead of
 * silently replacing or ignoring the edits.
 *
 * The form replaces the value object on every change (it deep-clones edits,
 * app/src/components/v-form/utils/selective-clone.ts), so a reference watch
 * sees every change, including the value coming back from our own Apply.
 * Comparing signatures tells the two apart.
 */
watch(
	() => props.value,
	(value) => {
		if (!props.open) return;

		const signature = valueSignature(value);

		if (signature === sourceSignature) {
			remote.value = null;
			return;
		}

		remote.value = { value, signature };
	},
);

function reloadRemote() {
	const pending = remote.value;
	if (!pending) return;

	const { document, problems } = normalizeDocument(pending.value);

	load({ document, source: pending.signature, created: false, repaired: problems.length > 0 });
	// load() resets `ready`, but the canvas stays mounted and will not report again.
	onReady();
}

function keepMine() {
	if (remote.value) sourceSignature = remote.value.signature;
	remote.value = null;
}

/* Commands ---------------------------------------------------------------- */

function onCommand(command: GraphCommand) {
	const current = graph.value;

	// The viewport is never recorded (undo should not move the view) and changes in read-only mode too.
	if (command.kind === 'setViewport') {
		history.replace(applyCommand(props.ruleset, current, command));
		return;
	}

	if (props.readOnly) return;

	let resolved = command;

	// Give new elements their id here, so the shell can select what was added.
	if (resolved.kind === 'addNode' && !resolved.id) resolved = { ...resolved, id: generateId('n') };
	if (resolved.kind === 'addEdge' && !resolved.id) resolved = { ...resolved, id: generateId('e') };

	const next = applyCommand(props.ruleset, current, resolved);

	if (next === current) {
		if (resolved.kind === 'moveNodes' && resolved.final) history.seal();
		explainRefusal(resolved, current);
		return;
	}

	switch (resolved.kind) {
		case 'moveNodes': {
			// One drag is one step: every `final: false` move and the drop share a key.
			const ids = resolved.moves.map((move) => move.id).sort().join(',');
			history.push(next, { coalesce: `move:${ids}` });
			if (resolved.final) history.seal();
			break;
		}

		case 'updateNodeData': {
			const keys = Object.keys(resolved.data).sort().join(',');
			history.push(next, { coalesce: `node:${resolved.id}:${keys}`, within: TYPING_WINDOW });
			break;
		}

		case 'updateEdge': {
			const keys = resolved.type !== undefined ? 'type' : Object.keys(resolved.data ?? {}).sort().join(',');
			history.push(next, { coalesce: `edge:${resolved.id}:${keys}`, within: TYPING_WINDOW });
			break;
		}

		default:
			history.push(next);
	}

	if (resolved.kind === 'addNode' && resolved.id) {
		selection.value = { kind: 'node', ids: [resolved.id] };
	}

	pruneSelection();
}

/** Tells the user why a command did nothing, where that is not obvious. */
function explainRefusal(command: GraphCommand, document: GraphDocument) {
	const references = referenceLabels.value.resolve;

	if (command.kind === 'addEdge') {
		const result = canConnect(props.ruleset, document, command, { references });
		if (!result.ok) showToast(result.message);
		return;
	}

	if (command.kind === 'reconnectEdge') {
		const result = canConnect(props.ruleset, document, command, { ignoreEdgeId: command.id, references });
		if (!result.ok) showToast(result.message);
		return;
	}

	if (command.kind === 'addNode') {
		/*
		 * Only name the limit when it is what refused the node: core blocks a
		 * type at `maxInstances` only while `max_instances` is an error
		 * (core/commands.ts addNode). The other refusals (an id taken or
		 * unusable, a bad position) come from a canvas bug, not from the user.
		 */
		const type = props.ruleset.nodeTypeMap.get(command.type);
		const max = type?.limits?.maxInstances;
		const used = document.nodes.filter((node) => node.type === command.type).length;

		if (type && max !== undefined && props.ruleset.severities.max_instances === 'error' && used >= max) {
			showToast(`${type.label}: limit reached (${max}).`);
		}

		return;
	}

	if (command.kind === 'removeElements' && command.nodeIds.length > 0) {
		showToast('The selected nodes cannot be deleted.');
	}
}

function onConnectRejected(reason: { message: string }) {
	showToast(reason.message);
}

function undo() {
	if (props.readOnly || !history.undo()) return;
	pruneSelection();
}

function redo() {
	if (props.readOnly || !history.redo()) return;
	pruneSelection();
}

/* Selection --------------------------------------------------------------- */

function onSelect(next: Selection | null) {
	selection.value = next && next.ids.length > 0 ? { kind: next.kind, ids: [...next.ids] } : null;
}

/** Drops ids that no longer exist (after a delete, undo or reload). */
function pruneSelection() {
	const current = selection.value;
	if (!current) return;

	const pool = current.kind === 'node' ? graph.value.nodes : graph.value.edges;
	const existing = new Set(pool.map((element) => element.id));
	const ids = current.ids.filter((id) => existing.has(id));

	if (ids.length === current.ids.length) return;
	selection.value = ids.length > 0 ? { kind: current.kind, ids } : null;
}

function deleteSelection() {
	const current = selection.value;
	if (props.readOnly || !current) return;

	onCommand({
		kind: 'removeElements',
		nodeIds: current.kind === 'node' ? current.ids : [],
		edgeIds: current.kind === 'edge' ? current.ids : [],
	});

	focusRoot();
}

function pickIssue(issue: Issue) {
	if (issue.nodeId) {
		selection.value = { kind: 'node', ids: [issue.nodeId] };
		canvasRef.value?.focusElement?.('node', issue.nodeId);
	} else if (issue.edgeId) {
		selection.value = { kind: 'edge', ids: [issue.edgeId] };
		canvasRef.value?.focusElement?.('edge', issue.edgeId);
	}
}

/* Palette ----------------------------------------------------------------- */

/** A palette click adds the node in the middle of the visible canvas, snapped and nudged off any card already there. */
function addFromPalette(type: string) {
	if (props.readOnly) return;

	const center: Position = canvasRef.value?.getViewportCenter?.() ?? { x: 0, y: 0 };
	const grid = props.options.gridSize;
	const snap = (value: number) => (props.options.snapToGrid ? Math.round(value / grid) * grid : Math.round(value));

	const x = snap(center.x - NODE_WIDTH / 2);
	let y = snap(center.y - NODE_HEADER_HEIGHT / 2);

	// Step down by two card headers (a multiple of the 18 px grid) until the header row is free.
	const step = props.options.snapToGrid ? Math.ceil((NODE_HEADER_HEIGHT * 2) / grid) * grid : NODE_HEADER_HEIGHT * 2;

	for (let attempt = 0; attempt < 50; attempt++) {
		const taken = graph.value.nodes.some(
			(node) => Math.abs(node.position.x - x) < NODE_WIDTH && Math.abs(node.position.y - y) < NODE_HEADER_HEIGHT,
		);

		if (!taken) break;
		y += step;
	}

	onCommand({ kind: 'addNode', type, position: { x, y }, id: generateId('n') });
}

/* Toasts ------------------------------------------------------------------ */

function showToast(text: string, type: 'danger' | 'info' = 'danger') {
	clearToast();
	toast.value = { type, text };
	toastTimer = setTimeout(clearToast, TOAST_DURATION);
}

function clearToast() {
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = null;
	toast.value = null;
}

/*
 * Apply and cancel ---------------------------------------------------------
 *
 * Apply normalises, validates, writes `meta` and the ruleset stamp and emits
 * the document once; it only stages the value in the form, like the
 * Repeater, and the user still saves the item. Applying a graph with errors
 * asks first, because the hook may reject the save. Cancelling with
 * unapplied changes asks too (the Repeater's checkDiscard pattern).
 */

function hasUnappliedChanges(): boolean {
	return hasGraphChanges(graph.value, baseline.value);
}

function requestApply(stay: boolean) {
	if (props.readOnly) {
		if (!stay) close();
		return;
	}

	const count = errorCount.value;

	if (count > 0) {
		confirmApply.value = { stay, errors: count };
		return;
	}

	commitApply(stay);
}

function applyAnyway() {
	const pending = confirmApply.value;
	confirmApply.value = null;
	if (pending) commitApply(pending.stay);
}

function commitApply(stay: boolean) {
	const current = graph.value;
	const unchanged = !created && !repaired && !hasUnappliedChanges() && sameViewport(current, baseline.value);

	if (!unchanged) {
		const { document } = prepareForApply(props.ruleset, current);
		// Set before emitting: the value comes straight back through `value`.
		sourceSignature = documentSignature(document);
		emit('apply', document);
	}

	baseline.value = current;
	created = false;
	repaired = false;
	remote.value = null;

	if (stay) {
		if (!unchanged) showToast('Applied. Save the item to keep the changes.', 'info');
		return;
	}

	close();
}

/** The drawer's X, Escape (when nothing else used it) and the overlay. */
function onCancel() {
	if (confirmDiscard.value || confirmApply.value) return;

	if (!props.readOnly && hasUnappliedChanges()) {
		confirmDiscard.value = true;
		return;
	}

	close();
}

function discardAndClose() {
	confirmDiscard.value = false;
	close();
}

function close() {
	emit('update:open', false);
}

/* Keyboard and focus ------------------------------------------------------ */

/*
 * One native keydown listener for every editor key. `useShortcut` is not
 * available to extensions, and the app's shortcuts listen on document.body
 * (use-shortcut.ts:17-32), which is above the drawer: stopping a key here
 * keeps it from the app. The listener sits on the drawer's own <article
 * class="v-drawer"> (v-drawer.vue:78) rather than on the body root, so keys
 * pressed while focus is on a header button or in the palette are handled
 * too (the header and sidebar live outside the default slot).
 */
let keyTarget: HTMLElement | null = null;

watch(
	rootRef,
	(root) => {
		detachRoot();
		if (!root) return;

		keyTarget = (root.closest('.v-drawer') as HTMLElement | null) ?? root;
		keyTarget.addEventListener('keydown', onKeydown);
		keyTarget.addEventListener('focusout', onFocusOut);

		/*
		 * Focus the editor once VDialog has activated its focus trap. The trap
		 * activates after `await nextTick()` (v-dialog.vue:96-105) and records
		 * the element focused at that moment as the one to return to on close
		 * (focus-trap 7.6.6 `activate`). Focusing now would make the trap
		 * return focus to this soon-to-be-removed root, which falls back to
		 * body, where ⌘S saves the item (shortcuts registered with a reference
		 * element also fire for <body>, use-shortcut.ts:41-55). A macrotask
		 * runs after the activation, so the Edit button gets focus back on
		 * close.
		 */
		setTimeout(() => focusRoot(), 0);
	},
	{ flush: 'post' },
);

function detachRoot() {
	if (!keyTarget) return;
	keyTarget.removeEventListener('keydown', onKeydown);
	keyTarget.removeEventListener('focusout', onFocusOut);
	keyTarget = null;
}

function focusRoot() {
	const root = rootRef.value;
	if (root && root.isConnected) root.focus({ preventScroll: true });
}

/*
 * If focus falls to <body> while the editor is open (the focused inspector
 * field was removed by a delete or undo, say), take it back. Shortcuts
 * registered with a reference element also fire for <body>
 * (use-shortcut.ts:41-55), so ⌘S would otherwise save the item without the
 * graph.
 */
function onFocusOut() {
	setTimeout(() => {
		if (props.open && document.activeElement === document.body) focusRoot();
	}, 0);
}

function onKeydown(event: KeyboardEvent) {
	const key = event.key;
	const lower = key.length === 1 ? key.toLowerCase() : key;
	const modifier = hasModifier(event);

	/*
	 * ⌘S applies and keeps the drawer open. Stopping it also keeps the item
	 * page's ⌘S (and ⌘⇧S, ⌘⌥S) from saving the item without the graph:
	 * item.vue registers them on the form element (app/src/modules/content/routes/item.vue:196-228),
	 * and on the item page that handler runs before the drawer's own ⌘S
	 * swallow (v-dialog.vue:46-49) because item.vue mounts last.
	 */
	if (modifier && lower === 's') {
		event.preventDefault();
		event.stopPropagation();
		if (!event.shiftKey && !event.altKey && !props.readOnly) requestApply(true);
		return;
	}

	if (key === 'Escape') {
		// A select menu in the inspector closes itself on Escape (v-menu.vue:126-131).
		if (isMenuOpen()) return;

		if (canvasRef.value?.cancelInteraction?.() === true) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		if (selection.value) {
			event.preventDefault();
			event.stopPropagation();
			selection.value = null;
			focusRoot();
			return;
		}

		// Nothing to cancel: let the drawer's Escape run (v-drawer.vue:72 → onCancel).
		return;
	}

	// Text controls keep their own Backspace, Delete and undo.
	if (isEditableTarget(event.target) || props.readOnly) return;

	if ((key === 'Delete' || key === 'Backspace') && !modifier) {
		if (!selection.value) return;
		event.preventDefault();
		event.stopPropagation();
		deleteSelection();
		return;
	}

	if (modifier && lower === 'z') {
		event.preventDefault();
		event.stopPropagation();
		if (event.shiftKey) redo();
		else undo();
		return;
	}

	if (event.ctrlKey && !event.metaKey && lower === 'y') {
		event.preventDefault();
		event.stopPropagation();
		redo();
	}
}

/* The canvas area --------------------------------------------------------- */

/** Refocus the editor on canvas pointerdown, so its keys work after editing a field in the inspector. */
function onStagePointerDown() {
	if (toast.value?.type === 'danger') clearToast();

	const root = rootRef.value;
	const active = document.activeElement;

	if (!root || !stageRef.value) return;
	if (active && active !== document.body && stageRef.value.contains(active)) return;

	root.focus({ preventScroll: true });
}

/*
 * Wheel and pinch belong to the canvas. The drawer's <main> is the scroll
 * container (v-drawer.vue:231-236); whatever the library does not consume
 * must not scroll it.
 */
function onStageWheel(event: WheelEvent) {
	if (event.cancelable && !event.defaultPrevented) event.preventDefault();
}

/* Labels ------------------------------------------------------------------ */

const labels = computed(() => ({
	undo: `Undo (${shortcutLabel(['meta', 'z'])})`,
	redo: `Redo (${shortcutLabel(['meta', 'shift', 'z'])})`,
	zoomOut: 'Zoom Out',
	zoomIn: 'Zoom In',
	fit: t('fit_to_screen', 'Fit to Screen'),
	issues: 'Issues',
	// The check applies and closes, like the drawer's ⌘⏎ (v-dialog.vue:39-44);
	// DrawerItem's check shows the same shortcut (overlay-item.vue:491-499, 665).
	apply: `${t('apply', 'Apply')} (${shortcutLabel(['meta', 'enter'])})`,
}));

const issuesIcon = computed(() => {
	if (errorCount.value > 0) return 'error';
	if (warningCount.value > 0) return 'warning';
	return 'check_circle';
});

const issueBadge = computed(() => {
	const count = issues.value.length;
	return count > 99 ? '99+' : count;
});

function toggleIssues() {
	issuesOpen.value = !issuesOpen.value;
}

defineExpose({ focus: focusRoot });
</script>

<template>
	<v-drawer
		:model-value="open"
		:title="title"
		:subtitle="subtitle"
		icon="account_tree"
		persistent
		sidebar-resizeable
		sidebar-label="Node Types"
		@cancel="onCancel"
		@apply="requestApply(false)"
	>
		<template v-if="!readOnly" #sidebar>
			<node-palette :ruleset="ruleset" :document="graph" @add="addFromPalette" />
		</template>

		<template #actions>
			<!-- The private-view header action button markup (private-view-header-bar-action-button.vue:24-40) -->
			<div class="node-graph-actions">
				<template v-if="!readOnly">
					<v-button
						v-tooltip.bottom="labels.undo"
						:aria-label="labels.undo"
						icon
						rounded
						small
						secondary
						:disabled="!canUndo"
						@click="undo"
					>
						<v-icon name="undo" small />
					</v-button>
					<v-button
						v-tooltip.bottom="labels.redo"
						:aria-label="labels.redo"
						icon
						rounded
						small
						secondary
						:disabled="!canRedo"
						@click="redo"
					>
						<v-icon name="redo" small />
					</v-button>
					<span class="ng-actions-spacer" />
				</template>

				<v-button
					v-tooltip.bottom="labels.zoomOut"
					:aria-label="labels.zoomOut"
					icon
					rounded
					small
					secondary
					@click="canvasRef?.zoomOut?.()"
				>
					<v-icon name="zoom_out" small />
				</v-button>
				<v-button
					v-tooltip.bottom="labels.zoomIn"
					:aria-label="labels.zoomIn"
					icon
					rounded
					small
					secondary
					@click="canvasRef?.zoomIn?.()"
				>
					<v-icon name="zoom_in" small />
				</v-button>
				<v-button v-tooltip.bottom="labels.fit" :aria-label="labels.fit" icon rounded small secondary @click="canvasRef?.fitView?.()">
					<v-icon name="fit_screen" small />
				</v-button>

				<template v-if="!readOnly">
					<span class="ng-actions-spacer" />

					<v-badge
						class="ng-issues-badge"
						:class="{ 'ng-issues-badge--warning': errorCount === 0 }"
						:value="issueBadge"
						:disabled="issues.length === 0"
						bordered
					>
						<v-button
							v-tooltip.bottom="labels.issues"
							:aria-label="labels.issues"
							:aria-pressed="issuesOpen ? 'true' : 'false'"
							class="ng-issues-toggle"
							:class="{ 'ng-issues-toggle--open': issuesOpen }"
							icon
							rounded
							small
							:secondary="!issuesOpen"
							@click="toggleIssues"
						>
							<v-icon :name="issuesIcon" small />
						</v-button>
					</v-badge>

					<span class="ng-actions-spacer" />

					<v-button v-tooltip.bottom="labels.apply" :aria-label="labels.apply" icon rounded small @click="requestApply(false)">
						<v-icon name="check" small />
					</v-button>
				</template>
			</div>
		</template>

		<div
			ref="rootRef"
			class="node-graph-editor"
			:class="[`node-graph-editor--${options.editorWidth}`, { 'node-graph-editor--readonly': readOnly }]"
			tabindex="-1"
		>
			<div class="ng-layout">
				<div ref="stageRef" class="ng-stage" @pointerdown.capture="onStagePointerDown" @wheel="onStageWheel">
					<component
						:is="registration.component"
						ref="canvasRef"
						class="ng-stage__canvas"
						:document="graph"
						:ruleset="ruleset"
						:read-only="readOnly"
						:selection="selection"
						:issues="issues"
						:snap-to-grid="options.snapToGrid"
						:grid-size="options.gridSize"
						:show-minimap="options.showMinimap"
						:instance-id="instanceId"
						:references="referenceLabels"
						@command="onCommand"
						@select="onSelect"
						@connect-rejected="onConnectRejected"
						@ready="onReady"
					/>

					<!--
						Title Case like the stock empty states ("No Flows", "Empty Item";
						directus-11.17.4/app/src/lang/translations/en-US.yaml:963, 1098). The
						copy does not say where the node types are: below 54rem the drawer
						shows them above the canvas ("Node Types"), not on the left.
					-->
					<div v-if="ready && graph.nodes.length === 0" class="ng-canvas-empty">
						<v-info icon="account_tree" title="Empty Graph">
							{{
								readOnly
									? 'This graph has no nodes.'
									: 'Drag a node type onto the canvas to start, or click one to add it to the middle.'
							}}
						</v-info>
					</div>

					<div class="ng-canvas-status" aria-hidden="true">{{ zoomPercent }}%</div>

					<transition name="ng-toast">
						<div v-if="toast" class="ng-canvas-toast ng-canvas-toast--bottom" role="status">
							<!-- No `multiline`: without a #title it puts the icon on a line of its own (v-notice.vue:146-148) -->
							<v-notice :type="toast.type">{{ toast.text }}</v-notice>
						</div>
					</transition>

					<div v-if="remote" class="ng-canvas-toast ng-canvas-toast--top" role="alert">
						<v-notice type="warning">
							<div class="ng-remote">
								<span>This field changed while you were editing.</span>
								<span class="ng-remote__actions">
									<v-button x-small secondary @click="reloadRemote">Reload</v-button>
									<v-button x-small @click="keepMine">Keep Mine</v-button>
								</span>
							</div>
						</v-notice>
					</div>

					<div v-if="!ready" class="ng-canvas-loading">
						<v-progress-circular indeterminate />
					</div>
				</div>

				<aside class="ng-panel ng-column">
					<node-inspector
						class="ng-column__inspector"
						:ruleset="ruleset"
						:document="graph"
						:baseline="baseline"
						:selection="selection"
						:issues="issues"
						:read-only="readOnly"
						:direction="direction"
						@command="onCommand"
						@delete="deleteSelection"
						@pick="pickIssue"
					/>

					<section v-if="issuesOpen || readOnly" class="ng-column__issues" aria-label="Issues">
						<header class="ng-panel-header">
							<v-icon :name="issuesIcon" />
							<span class="ng-panel-header__title">Issues</span>
							<span v-if="errorCount > 0" class="ng-issue-chip ng-issue-chip--error">
								<v-icon name="error" />
								{{ errorCount }}
							</span>
							<span v-if="warningCount > 0" class="ng-issue-chip ng-issue-chip--warning">
								<v-icon name="warning" />
								{{ warningCount }}
							</span>
						</header>
						<div class="ng-column__issues-body">
							<issue-list :issues="issues" :ruleset="ruleset" :document="graph" @pick="pickIssue" />
						</div>
					</section>
				</aside>
			</div>

			<!--
				Both dialogs are declared inside the drawer's slot, so they mount
				when the drawer opens: after it in #dialog-outlet (on top) and in
				front of it in the Escape queue, since both orders are fixed when a
				VDialog mounts (see the header comment). The discard dialog follows
				the Repeater's (list.vue:317-328).
			-->
			<v-dialog v-model="confirmDiscard" @esc="confirmDiscard = false" @apply="discardAndClose">
				<v-card>
					<v-card-title>{{ t('unsaved_changes', 'Unsaved Changes') }}</v-card-title>
					<v-card-text>{{ t('discard_changes_copy', 'Are you sure you want to discard all the changes made?') }}</v-card-text>
					<v-card-actions>
						<v-button secondary @click="discardAndClose">{{ t('discard_changes', 'Discard Changes') }}</v-button>
						<v-button @click="confirmDiscard = false">{{ t('keep_editing', 'Keep Editing') }}</v-button>
					</v-card-actions>
				</v-card>
			</v-dialog>

			<v-dialog
				:model-value="confirmApply !== null"
				@update:model-value="(value: boolean) => !value && (confirmApply = null)"
				@esc="confirmApply = null"
				@apply="applyAnyway"
			>
				<v-card>
					<v-card-title>Apply With Errors?</v-card-title>
					<v-card-text>
						This graph has {{ confirmApply?.errors }} {{ confirmApply?.errors === 1 ? 'error' : 'errors' }}.
						<template v-if="options.enforcement === 'log' || options.enforcement === 'off'">
							You can apply it; this field accepts graphs with errors when the item is saved.
						</template>
						<template v-else>You can apply it, but saving the item may be rejected.</template>
					</v-card-text>
					<v-card-actions>
						<v-button secondary @click="confirmApply = null">{{ t('keep_editing', 'Keep Editing') }}</v-button>
						<v-button kind="warning" @click="applyAnyway">Apply Anyway</v-button>
					</v-card-actions>
				</v-card>
			</v-dialog>
		</div>
	</v-drawer>
</template>

<style scoped>
/* Header actions: the drawer header's action row (private-view-header-bar-actions.vue:9-18) */
.node-graph-actions {
	display: flex;
	gap: 0.4375rem;
	align-items: center;
}

/* Directus headers group buttons with space, not dividers (docs/design.md §9.2) */
.ng-actions-spacer {
	inline-size: 0.25rem;
}

/* The issue count: a bordered badge in danger (warning when there are only warnings) */
.ng-issues-badge {
	--v-badge-background-color: var(--theme--danger);
	--v-badge-color: var(--theme--background-normal);
	--v-badge-border-color: var(--theme--header--background);
}

.ng-issues-badge--warning {
	--v-badge-background-color: var(--theme--warning);
}

/* Open: the active header button colours of the Flows editor (modules/settings/routes/flows/flow.vue:789-794) */
.ng-issues-toggle--open {
	--v-button-background-color: var(--theme--primary-background);
	--v-button-color: var(--theme--primary);
	--v-button-background-color-hover: var(--theme--primary-subdued);
	--v-button-color-hover: var(--theme--primary);
	--v-button-background-color-active: var(--theme--primary-background);
	--v-button-color-active: var(--theme--primary);
}

/*
 * The body fills what the sticky drawer header leaves of the drawer. The
 * drawer's .content is a size container (v-drawer.vue:177) and the header
 * (var(--header-bar-height), v-drawer-header.vue:93) scrolls inside <main>,
 * so 100cqh minus the header is exactly the visible height and <main> has
 * nothing to scroll (docs/design.md §9.4).
 */
.node-graph-editor {
	position: relative;
	container-type: inline-size;
	/* Inside <main>'s flex column (unscoped rule at the end) the body takes what the header and the narrow-screen palette leave */
	flex: 1 1 0;
	block-size: calc(100cqh - var(--header-bar-height, 3.375rem));
	min-block-size: 25rem;
	overflow: hidden;
}

/*
 * The root is focused only so the editor's keys reach it; it is not in the
 * tab order (tabindex -1). After any key press Chrome treats it as
 * :focus-visible, and Directus's ring for focused divs, 2px dotted primary
 * drawn inside the box
 * (directus-11.17.4/app/src/styles/_base.scss:52-60), then framed the whole
 * editor body, most visibly along the inspector column. The controls inside
 * keep their own focus rings.
 */
.node-graph-editor:focus-visible {
	outline: none;
}

.ng-layout {
	display: grid;
	grid-template-rows: minmax(0, 1fr);
	grid-template-columns: minmax(0, 1fr) var(--ng-inspector-width);
	block-size: 100%;
}

/*
 * Stack the column under the canvas when the 22rem inspector would leave
 * the canvas less than about 28rem: the standard drawer with the palette
 * open (about 35rem), and any drawer below the 54rem breakpoint, where the
 * drawer is at most 48.125rem wide and the palette moves into a VDetail
 * above the body. Graphs run left to right, so a full-width canvas shows far
 * more of them than a narrow column next to the inspector.
 */
@container (width < 50rem) {
	.ng-layout {
		grid-template-rows: minmax(0, 1fr) minmax(0, 45%);
		grid-template-columns: minmax(0, 1fr);
	}
}

.ng-stage {
	position: relative;
	min-inline-size: 0;
	min-block-size: 0;
	overflow: hidden;
}

/*
 * The canvas fills the stage and is its own stacking context, so z-indexes
 * inside the library (raised nodes, edge layers) never climb over the
 * shell's overlays (docs/design.md §4.1, paint order).
 */
.ng-stage__canvas {
	isolation: isolate;
	inline-size: 100%;
	block-size: 100%;
}

.ng-column {
	display: flex;
	flex-direction: column;
	min-block-size: 0;
	overflow: hidden;
}

/* The inspector takes what the issues section (at most 40%) leaves, and scrolls inside (NodeInspector.vue) */
.ng-column__inspector {
	flex: 1 1 0;
	min-block-size: 0;
}

.ng-column__issues {
	display: flex;
	flex: 0 1 auto;
	flex-direction: column;
	max-block-size: 40%;
	min-block-size: 0;
}

.ng-column__issues-body {
	min-block-size: 0;
	overflow: auto;
	overscroll-behavior: contain;
}

/* The counts end 1rem from the edge, in line with the inspector's delete icon (the header's own end padding is 0.5rem). */
.ng-column__issues .ng-panel-header .ng-issue-chip:last-child {
	margin-inline-end: 0.5rem;
}

.ng-remote {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem 0.75rem;
	align-items: center;
}

.ng-remote__actions {
	display: inline-flex;
	gap: 0.5rem;
}

.ng-toast-enter-active,
.ng-toast-leave-active {
	transition: opacity var(--fast, 125ms) var(--transition, ease);
}

.ng-toast-enter-from,
.ng-toast-leave-to {
	opacity: 0;
}
</style>

<style>
/*
 * Widening the stock drawer (docs/design.md §9.1). VDrawer caps its article at
 * 48.125rem with a scoped rule, `.v-drawer[data-v-…] { max-inline-size: 48.125rem }`
 * (directus-11.17.4/app/src/components/v-drawer.vue:141-146, specificity
 * 0,2,0), and has no width prop. The drawer is teleported into
 * #dialog-outlet (v-dialog.vue:113), so this rule keys on that outlet and on
 * the editor's own root class inside the drawer: 1,1,0 plus the :has()
 * argument (0,1,0) = 1,2,0, which beats the scoped rule without !important.
 * Only a drawer that contains this editor's body matches; drawers stacked
 * on top (a Repeater opened from the inspector, say) are separate
 * containers in the outlet and keep the stock width. With `none`, the stock
 * `inline-size: calc(100% - 3.625rem)` (v-drawer.vue:243-245) still leaves
 * room for the X on the left. Re-check on Directus upgrades.
 */
#dialog-outlet .v-drawer:has(.node-graph-editor--wide) {
	max-inline-size: max(48.125rem, 80vw);
}

#dialog-outlet .v-drawer:has(.node-graph-editor--full) {
	max-inline-size: none;
}

/*
 * Below 54rem the drawer hides its sidebar and renders the palette again in
 * a VDetail above the default slot, inside the scrolling <main>
 * (v-drawer.vue:108-134, 248-260). A body sized to 100cqh minus the header
 * would then overflow <main> by that block and cut off the bottom of the
 * inspector and the canvas status. Making this
 * drawer's <main> a flex column lets the body take exactly what is left
 * (`flex: 1 1 0` in the scoped rules, 25rem at least), with the palette open
 * or closed; the header and the palette keep their own height. Above 54rem
 * the VDetail is `display: none` and the result is the same as the 100cqh
 * rule. Keyed on the stock class names, like the width rules above; re-check
 * on Directus upgrades.
 */
#dialog-outlet .v-drawer:has(.node-graph-editor) > .content > .main {
	display: flex;
	flex-direction: column;
}

#dialog-outlet .v-drawer:has(.node-graph-editor) > .content > .main > :not(.node-graph-editor) {
	flex-shrink: 0;
}
</style>
