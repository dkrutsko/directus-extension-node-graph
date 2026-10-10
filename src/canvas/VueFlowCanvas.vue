<script setup lang="ts">
/**
 * The Vue Flow canvas: implements shared/ui/canvas-contract.ts with
 * @vue-flow/core 1.48.2.
 *
 * Data flow
 * ---------
 * The graph document (prop) is the source of truth. Vue Flow's store holds
 * one node per document node (id, position, aria label) and one edge per
 * drawable document edge (id, endpoints); NodeCard and EdgePath read
 * everything they show from the document through the canvas context
 * (context.ts). Vue Flow applies its own changes (drag positions,
 * measurements, selection) to its store as usual (`applyDefault`), and the
 * canvas turns the user's gestures into contract commands and selection
 * events:
 *
 *   node drag          onNodeDrag / onNodeDragStop  → moveNodes (final false / true)
 *   selection drag     onSelectionDrag(Stop)        → moveNodes
 *   new connection     onConnect                    → addEdge (only if canConnect passes)
 *   edge end moved     onEdgeUpdate                 → reconnectEdge (only if canConnect passes)
 *   click, marquee     onNodesChange/onEdgesChange  → select
 *   pan, zoom          onViewportChange             → setViewport
 *   palette drop       native drop on the root      → addNode
 *
 * When the document changes (every command comes back as a new document;
 * undo and redo replace it wholesale) the store is reconciled incrementally:
 * unchanged node objects are skipped, moved nodes get a new position, and
 * only a change in the set of elements goes through setNodes / setEdges.
 *
 * Library behaviour this canvas works around (more in docs/design.md §13.1)
 * -------------------------------------------------------------------------
 * - The store-level `isValidConnection` is never set: createGraphEdges runs
 *   it on every edge passed to setEdges/addEdges and silently drops the ones
 *   it rejects (vue-flow-core.mjs:4836-4876), which would lose stored edges
 *   that break a rule. Validation happens per Handle while drawing instead.
 * - Keyboard handling is off: Vue Flow listens for its key codes on
 *   `document` (useKeyPress, vue-flow-core.mjs:3360, 3402-3477), not on the
 *   canvas, so Backspace in another drawer would delete the selection. The
 *   shell owns the keyboard; Enter/Space selection and arrow-key moves on a
 *   focused card are re-implemented here as commands.
 * - Edges whose source or target node is missing cannot be drawn by Vue Flow
 *   (EdgeWrapper renders nothing, vue-flow-core.mjs:8879-8891) and are left out of the store;
 *   they stay in the document and the issues list reports them
 *   (`dangling_edge`). Edges to undeclared ports are drawn to placeholder
 *   handles that NodeCard renders from getDocumentPorts().
 */

import '@vue-flow/core/dist/style.css';
import './directus-theme.css';

import {
	ConnectionMode,
	useVueFlow,
	VueFlow,
	type Connection as FlowConnection,
	type Edge as FlowEdgeInput,
	type EdgeTypesObject,
	type GraphNode as FlowNode,
	type Node as FlowNodeInput,
	type NodeTypesObject,
} from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import { computed, markRaw, nextTick, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue';
import {
	canConnect,
	getDocumentPorts,
	nodeTitle,
	type CompiledRuleset,
	type ConnectResult,
	type Connection,
	type GraphCommand,
	type GraphEdge,
	type GraphNode,
	type Issue,
	type IssueCode,
	type Position,
} from '../shared/core';
import { PALETTE_DRAG_MIME, type CanvasExpose, type CanvasProps, type Selection } from '../shared/ui/canvas-contract';
import { isEditableTarget } from '../shared/ui/platform';
import ConnectionPath from './ConnectionPath.vue';
import {
	CANVAS_CONTEXT,
	fromFlowId,
	handleKey,
	issueTooltip,
	NODE_HEADER_HEIGHT,
	NODE_WIDTH,
	portKey,
	toFlowId,
	type CanvasContext,
	type DrawState,
	type ElementIssues,
	type HandleType,
} from './context';
import EdgePath from './EdgePath.vue';
import NodeCard from './NodeCard.vue';

const props = defineProps<CanvasProps>();

const emit = defineEmits<{
	command: [command: GraphCommand];
	select: [selection: Selection | null];
	'connect-rejected': [reason: { code: IssueCode; message: string }];
	ready: [];
}>();

/** The only node and edge types registered with Vue Flow; every element uses them. */
const NODE_TYPE = 'ng-node';
const EDGE_TYPE = 'ng-edge';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
/** fitView padding, as a fraction of the canvas size. */
const FIT_PADDING = 0.15;
/** fitView never zooms a small graph in past 100%. */
const FIT_MAX_ZOOM = 1;
/** Header buttons and focusElement animate like Directus's --medium transition. */
const ANIMATION_MS = 200;
/** Emit `ready` even if Vue Flow never reports measured nodes. */
const INIT_FALLBACK_MS = 2000;
/** A Vue Flow connection snaps to a handle within this many screen px (default 20); a little over the 24px hit target. */
const CONNECTION_RADIUS = 24;
/** Below this many screen px between grid dots the .ng-grid layer is hidden (docs/design.md §4.1). */
const MIN_GRID_STEP = 9;
/** Prefix for console warnings. */
const LOG_PREFIX = '[node-graph]';

/*
 * Vue Flow types its node and edge components as taking every NodeProps /
 * EdgeProps member; NodeCard and EdgePath declare only the members they read
 * (the rest arrive as attrs), so the maps are cast to Vue Flow's own types.
 */
const nodeTypes = { [NODE_TYPE]: markRaw(NodeCard) } as unknown as NodeTypesObject;
const edgeTypes = { [EDGE_TYPE]: markRaw(EdgePath) } as unknown as EdgeTypesObject;

/*
 * One Vue Flow store per mounted canvas. The drawer unmounts its content on
 * close (v-dialog.vue:113-118), but a quick close and reopen can overlap the
 * leave transition, so the editor's instanceId alone could briefly name two
 * live canvases; the sequence number keeps their stores apart.
 */
const flowId = `${props.instanceId}-vueflow-${++mountSequence}`;
const flow = useVueFlow(flowId);

const rootRef = ref<HTMLElement | null>(null);

/* Derived document state (shared with NodeCard / EdgePath) ----------------- */

/** First node per id: a duplicate id (a `duplicate_id` issue) cannot be drawn twice by Vue Flow. */
const nodeById = computed(() => {
	const map = new Map<string, GraphNode>();
	for (const node of props.document.nodes) if (!map.has(node.id)) map.set(node.id, node);
	return map;
});

const edgeById = computed(() => {
	const map = new Map<string, GraphEdge>();
	for (const edge of props.document.edges) if (!map.has(edge.id)) map.set(edge.id, edge);
	return map;
});

const ports = computed(() => getDocumentPorts(props.ruleset, props.document));

/** Edges Vue Flow can draw: both end nodes exist. */
const drawableEdges = computed(() => {
	const nodes = nodeById.value;
	return [...edgeById.value.values()].filter((edge) => nodes.has(edge.source) && nodes.has(edge.target));
});

const connectedPorts = computed(() => {
	const set = new Set<string>();

	for (const edge of drawableEdges.value) {
		set.add(portKey(edge.source, 'output', edge.sourceHandle));
		set.add(portKey(edge.target, 'input', edge.targetHandle));
	}

	return set;
});

const nodeIssues = computed(() => {
	const grouped = new Map<string, { errors: Issue[]; warnings: Issue[] }>();

	for (const issue of props.issues) {
		// Issues about an edge are shown on the edge, not as a badge on its nodes.
		if (!issue.nodeId || issue.edgeId) continue;

		let entry = grouped.get(issue.nodeId);

		if (!entry) {
			entry = { errors: [], warnings: [] };
			grouped.set(issue.nodeId, entry);
		}

		(issue.severity === 'error' ? entry.errors : entry.warnings).push(issue);
	}

	const result = new Map<string, ElementIssues>();

	for (const [id, entry] of grouped) {
		result.set(id, {
			errors: entry.errors.length,
			warnings: entry.warnings.length,
			errorText: issueTooltip(entry.errors),
			warningText: issueTooltip(entry.warnings),
		});
	}

	return result;
});

const edgeSeverity = computed(() => {
	const map = new Map<string, 'error' | 'warning'>();

	for (const issue of props.issues) {
		if (!issue.edgeId) continue;
		if (issue.severity === 'error' || !map.has(issue.edgeId)) map.set(issue.edgeId, issue.severity);
	}

	return map;
});

/** The port issues of docs/design.md §6.2 that colour a handle's ring. */
const PORT_ISSUE_CODES = new Set(['max_connections', 'min_connections', 'unknown_port']);

/**
 * Per node, the keys of its ports named by a port issue of one severity.
 * The ring takes the severity's colour (ng-handle--error / --warning), so a
 * warning such as min_connections reads orange like the card's warning
 * badge instead of red.
 */
function portIssueKeys(severity: Issue['severity']): Map<string, string> {
	const keys = new Map<string, string[]>();

	for (const issue of props.issues) {
		if (issue.severity !== severity || !issue.nodeId || issue.port === undefined || !PORT_ISSUE_CODES.has(issue.code)) continue;
		const list = keys.get(issue.nodeId) ?? [];
		if (!list.includes(issue.port)) list.push(issue.port);
		keys.set(issue.nodeId, list);
	}

	return new Map([...keys].map(([id, list]) => [id, list.sort().join('\u0000')]));
}

const portsWithIssues = computed(() => portIssueKeys('error'));
const portsWithWarnings = computed(() => portIssueKeys('warning'));

const selectedNodes = computed(() => new Set(props.selection?.kind === 'node' ? props.selection.ids : []));
const selectedEdges = computed(() => new Set(props.selection?.kind === 'edge' ? props.selection.ids : []));

const drawState = shallowRef<DrawState | null>(null);

const targetHandle = computed(() => {
	const end = flow.connectionEndHandle.value;
	if (!end || !end.nodeId || !end.type) return null;
	return handleKey(end.nodeId, end.type, end.id ?? '');
});

const context: CanvasContext = {
	ruleset: computed(() => props.ruleset),
	document: computed(() => props.document),
	readOnly: computed(() => props.readOnly),
	nodeById,
	edgeById,
	ports,
	connectedPorts,
	nodeIssues,
	edgeSeverity,
	portsWithIssues,
	portsWithWarnings,
	selectedNodes,
	selectedEdges,
	drawing: drawState,
	targetHandle,
	isValidConnection,
	selectEdge,
};

provide(CANVAS_CONTEXT, context);

/* Viewport and grid ---------------------------------------------------------- */

/*
 * The stored viewport is restored when it still shows part of the graph
 * (so opening and applying without edits stages no change); otherwise the
 * canvas fits the graph once its cards are measured (see initialise()).
 */
const initialViewport = props.document.viewport
	? { ...props.document.viewport }
	: { x: props.gridSize * 2, y: props.gridSize * 2, zoom: 1 };

/*
 * The grid's variables go on the `.ng-grid` element only (theme.css reads
 * them there), not on the `.ng-canvas` root: custom properties inherit, so
 * changing them on the root every pan and zoom frame made Chrome recalculate
 * the style of every element of every card (about 2.3 s of style work in a
 * 30-step pan of a 500-node graph, 16-17 fps; 37-40 fps with the variables
 * on the grid layer).
 */
const gridStyle = computed(() => {
	const { x, y, zoom } = flow.viewport.value;

	return {
		'--ng-viewport-x': `${x}px`,
		'--ng-viewport-y': `${y}px`,
		'--ng-viewport-zoom': String(zoom),
		'--ng-grid-size': `${props.gridSize}px`,
	};
});

const gridHidden = computed(() => props.gridSize * flow.viewport.value.zoom < MIN_GRID_STEP);

let initialised = false;
let viewportFrame = 0;
const initFallback = setTimeout(() => initialise(true), INIT_FALLBACK_MS);

flow.onInit(() => initialise(false));
flow.onNodesInitialized(() => initialise(false));

/**
 * Runs once, when the pane has a size and every card has been measured:
 * restores the positions Vue Flow snapped on mount, frames the graph if the
 * stored viewport does not show it, then reports `ready` and the viewport.
 */
function initialise(force: boolean) {
	if (initialised) return;

	const helperReady = flow.viewportHelper.value.viewportInitialized;
	const nodes = flow.nodes.value;
	const measured = nodes.every((node) => node.dimensions.width > 0 && node.dimensions.height > 0);

	if (!force && (!helperReady || !measured)) return;

	initialised = true;
	clearTimeout(initFallback);
	restorePositions();

	if (helperReady && nodes.length > 0 && (!props.document.viewport || !anyNodeVisible())) {
		void flow.fitView({ padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM });
	}

	emitViewport();
	emit('ready');
}

/** Whether at least one card is entirely inside the visible area. */
function anyNodeVisible(): boolean {
	const { width, height } = flow.dimensions.value;
	const { x, y, zoom } = flow.viewport.value;

	const left = -x / zoom;
	const top = -y / zoom;
	const right = (width - x) / zoom;
	const bottom = (height - y) / zoom;

	return flow.nodes.value.some((node) => {
		const position = node.computedPosition;
		return position.x >= left && position.y >= top && position.x + node.dimensions.width <= right && position.y + node.dimensions.height <= bottom;
	});
}

/* The shell's zoom readout comes from setViewport commands, so every view change is reported, once per frame. */
flow.onViewportChange(() => {
	if (!initialised || viewportFrame) return;

	viewportFrame = requestAnimationFrame(() => {
		viewportFrame = 0;
		emitViewport();
	});
});

function emitViewport() {
	const { x, y, zoom } = flow.viewport.value;

	emit('command', {
		kind: 'setViewport',
		viewport: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, zoom: Math.round(zoom * 10000) / 10000 },
	});
}

/* Reconciling: document → Vue Flow store ------------------------------------ */

/** Document node and edge objects last pushed into the store, by document id. */
const syncedNodes = new Map<string, GraphNode>();
let syncedEdges = new Map<string, GraphEdge>();
let syncedRuleset: CompiledRuleset | null = null;

function nodeAriaLabel(node: GraphNode): string {
	const type = props.ruleset.nodeTypeMap.get(node.type);
	return `${type?.label ?? 'Unknown type'}: ${nodeTitle(props.ruleset, node)}`;
}

function edgeAriaLabel(edge: GraphEdge): string {
	const source = nodeById.value.get(edge.source);
	const target = nodeById.value.get(edge.target);
	const name = (node: GraphNode | undefined) => (node ? nodeTitle(props.ruleset, node) : '?');
	return `Connection from ${name(source)} to ${name(target)}`;
}

function toFlowNode(node: GraphNode): FlowNodeInput {
	return {
		id: toFlowId(node.id),
		type: NODE_TYPE,
		// A copy: Vue Flow replaces and snaps positions in its store.
		position: { x: node.position.x, y: node.position.y },
		data: {},
		ariaLabel: nodeAriaLabel(node),
		// Vue Flow never removes anything itself (no delete key); the shell does, through commands.
		deletable: false,
	};
}

function toFlowEdge(edge: GraphEdge): FlowEdgeInput {
	return {
		id: toFlowId(edge.id),
		type: EDGE_TYPE,
		source: toFlowId(edge.source),
		target: toFlowId(edge.target),
		sourceHandle: toFlowId(edge.sourceHandle),
		targetHandle: toFlowId(edge.targetHandle),
		data: {},
		ariaLabel: edgeAriaLabel(edge),
		deletable: false,
	};
}

/**
 * Brings the store's nodes in line with the document. `structural` is true
 * when the set or order of nodes changed (setNodes was needed), `relabelled`
 * when a node's accessible name changed (its title, or the ruleset), which
 * the edges' names depend on too.
 */
function syncNodes(): { structural: boolean; relabelled: boolean } {
	const nodes = [...nodeById.value.values()];
	const store = flow.nodes.value;
	const rulesetChanged = syncedRuleset !== props.ruleset;
	syncedRuleset = props.ruleset;

	const sameOrder = store.length === nodes.length && nodes.every((node, index) => store[index]?.id === toFlowId(node.id));

	if (!sameOrder) {
		// createGraphNodes reuses the store object of every id it already knows (vue-flow-core.mjs:4737-4769).
		flow.setNodes(nodes.map(toFlowNode));
		syncedNodes.clear();
		for (const node of nodes) syncedNodes.set(node.id, node);
		return { structural: true, relabelled: true };
	}

	let relabelled = rulesetChanged;

	nodes.forEach((node, index) => {
		// Documents are immutable (applyCommand copies only what changes), so an unchanged object needs nothing.
		if (!rulesetChanged && syncedNodes.get(node.id) === node) return;

		const flowNode = store[index]!;

		if (flowNode.position.x !== node.position.x || flowNode.position.y !== node.position.y) {
			// NodeWrapper watches position.x/y and recomputes computedPosition (vue-flow-core.mjs:9505-9540).
			flowNode.position = { x: node.position.x, y: node.position.y };
		}

		const label = nodeAriaLabel(node);

		if (flowNode.ariaLabel !== label) {
			flowNode.ariaLabel = label;
			relabelled = true;
		}

		syncedNodes.set(node.id, node);
	});

	return { structural: false, relabelled };
}

/**
 * Brings the store's edges in line with the document. Selected edges are
 * kept last, so they paint above the other edges and still under every card
 * (Vue Flow draws each edge in its own z-index-0 SVG before the nodes
 * layer, vue-flow-core.mjs:9356-9377; a raised z-index would lift the edge
 * over unselected cards instead).
 */
function syncEdges(force: boolean) {
	const selected = selectedEdges.value;
	const drawable = drawableEdges.value;
	const ordered = [...drawable.filter((edge) => !selected.has(edge.id)), ...drawable.filter((edge) => selected.has(edge.id))];
	const store = flow.edges.value;

	const sameElements = !force && store.length === ordered.length && ordered.every((edge) => syncedEdges.get(edge.id) === edge);

	if (sameElements) {
		const sameOrder = ordered.every((edge, index) => store[index]?.id === toFlowId(edge.id));
		if (sameOrder) return;

		// Only the order changed (an edge was selected): reorder the existing store objects.
		const byId = new Map(store.map((edge) => [edge.id, edge]));
		const reordered = ordered.map((edge) => byId.get(toFlowId(edge.id)));

		if (reordered.every((edge) => edge !== undefined)) {
			flow.edges.value = reordered as typeof store;
			return;
		}
	}

	flow.setEdges(ordered.map(toFlowEdge));
	syncedEdges = new Map(ordered.map((edge) => [edge.id, edge]));
}

/*
 * An edge's accessible name ("Connection from <source> to <target>") names
 * both end cards, whose titles change without the edge changing (renaming a
 * Task in the inspector, say), so syncEdges() alone would leave it stale.
 * Only runs when a node's name changed, not on every drag frame.
 */
function relabelEdges() {
	for (const flowEdge of flow.edges.value) {
		const edge = edgeById.value.get(fromFlowId(flowEdge.id));
		if (!edge) continue;

		const label = edgeAriaLabel(edge);
		if (flowEdge.ariaLabel !== label) flowEdge.ariaLabel = label;
	}
}

/**
 * Mirrors the shell's selection into the store. Assigning `selected`
 * directly emits no change events, so this never loops back through
 * pushSelection().
 */
function applySelection() {
	const nodes = selectedNodes.value;
	const edges = selectedEdges.value;

	for (const node of flow.nodes.value) {
		const wanted = nodes.has(fromFlowId(node.id));
		if (node.selected !== wanted) node.selected = wanted;
	}

	for (const edge of flow.edges.value) {
		const wanted = edges.has(fromFlowId(edge.id));
		if (edge.selected !== wanted) edge.selected = wanted;
	}

	// The marquee's group rectangle only makes sense while its nodes are selected.
	if (nodes.size === 0 && flow.nodesSelectionActive.value) flow.nodesSelectionActive.value = false;
}

/**
 * With snapToGrid on, Vue Flow snaps every node to the grid when its
 * wrapper mounts (clampPosition2, vue-flow-core.mjs:9627-9642), so a stored
 * off-grid position (the starter's End at x = 480, say) would be drawn
 * somewhere the document does not say. Put the document's position back;
 * the next drag snaps it for real, through a command.
 */
function restorePositions() {
	for (const flowNode of flow.nodes.value) {
		if (flowNode.dragging) continue;

		const node = nodeById.value.get(fromFlowId(flowNode.id));
		if (!node) continue;

		if (flowNode.position.x !== node.position.x || flowNode.position.y !== node.position.y) {
			flowNode.position = { x: node.position.x, y: node.position.y };
		}
	}
}

function sync() {
	const { structural, relabelled } = syncNodes();
	syncEdges(structural);
	if (relabelled && !structural) relabelEdges();
	applySelection();

	if (structural) void nextTick(restorePositions);
}

watch([() => props.document.nodes, () => props.document.edges, () => props.ruleset, () => props.selection], sync, {
	immediate: true,
});

/* Selection: Vue Flow → shell ----------------------------------------------- */

let selectionQueued = false;

flow.onNodesChange((changes) => {
	if (changes.some((change) => change.type === 'select')) queueSelectionSync();
});

flow.onEdgesChange((changes) => {
	if (changes.some((change) => change.type === 'select')) queueSelectionSync();
});

/** A click produces a node and an edge change batch back to back; report the result once. */
function queueSelectionSync() {
	if (selectionQueued) return;
	selectionQueued = true;

	queueMicrotask(() => {
		selectionQueued = false;
		pushSelection();
	});
}

function pushSelection() {
	const nodes = flow.getSelectedNodes.value.map((node) => fromFlowId(node.id));
	const edges = flow.getSelectedEdges.value.map((edge) => fromFlowId(edge.id));

	// The contract's selection is one kind; a marquee that caught nodes and edges selects the nodes.
	const next: Selection | null =
		nodes.length > 0 ? { kind: 'node', ids: nodes } : edges.length > 0 ? { kind: 'edge', ids: edges } : null;

	if (sameSelection(next, props.selection)) return;
	emit('select', next);
}

function sameSelection(a: Selection | null, b: Selection | null): boolean {
	if (!a || !b) return a === b;
	if (a.kind !== b.kind || a.ids.length !== b.ids.length) return false;

	const ids = new Set(b.ids);
	return a.ids.every((id) => ids.has(id));
}

function selectEdge(flowEdgeId: string) {
	const edge = flow.findEdge(flowEdgeId);
	if (!edge) return;

	flow.nodesSelectionActive.value = false;
	flow.addSelectedEdges([edge]);
}

/* Moves ------------------------------------------------------------------------ */

let dragMoved = false;

flow.onNodeDrag(({ nodes }) => emitMoves(nodes, false));
flow.onNodeDragStop(({ nodes }) => emitMoves(nodes, true));
flow.onSelectionDrag(({ nodes }) => emitMoves(nodes, false));
flow.onSelectionDragStop(({ nodes }) => emitMoves(nodes, true));

/**
 * Drag frames become `moveNodes` with `final: false` and the drop one
 * `final: true` (the shell coalesces them into one undo step). The nodes'
 * store positions are already snapped by Vue Flow's drag (useDrag,
 * vue-flow-core.mjs:4920-4945). A press without movement emits nothing.
 */
function emitMoves(nodes: FlowNode[], final: boolean) {
	if (props.readOnly || nodes.length === 0) return;

	if (final) {
		if (!dragMoved) return;
		dragMoved = false;
	} else {
		dragMoved = true;
	}

	emit('command', {
		kind: 'moveNodes',
		moves: nodes.map((node) => ({ id: fromFlowId(node.id), position: { x: node.position.x, y: node.position.y } })),
		final,
	});
}

/* Connections ------------------------------------------------------------------ */

/** The gesture in progress: cancelled by Escape, or already turned into a command. */
let gesture: { cancelled: boolean; handled: boolean } | null = null;
/** The edge whose end the user grabbed, and the mousedown that grabbed it. */
let pendingReconnect: { edgeId: string; event: unknown } | null = null;

flow.onEdgeUpdateStart(({ edge, event }) => {
	pendingReconnect = { edgeId: fromFlowId(edge.id), event };
});

flow.onEdgeUpdateEnd(() => {
	pendingReconnect = null;
});

/*
 * Both a new connection and a moved edge end start here (an edge update
 * goes through the same useHandle pointer logic, vue-flow-core.mjs:9036-9046,
 * emitting edgeUpdateStart and then connectStart for the same mousedown).
 * Every port the gesture could end on gets its canConnect() verdict now, so
 * handles can show valid / invalid while the line is drawn (docs/design.md §6.2).
 */
flow.onConnectStart(({ event, nodeId, handleId, handleType }) => {
	const reconnect = pendingReconnect && pendingReconnect.event === event ? (edgeById.value.get(pendingReconnect.edgeId) ?? null) : null;
	pendingReconnect = null;

	if (props.readOnly || !nodeId || !handleType) return;

	drawState.value = startDrawing(nodeId, handleId ?? '', handleType, reconnect);
	gesture = { cancelled: false, handled: false };
});

flow.onConnect((flowConnection) => {
	if (!gesture || gesture.cancelled || props.readOnly) return;
	gesture.handled = true;

	const connection = toDocumentConnection(flowConnection);
	const result = canConnect(props.ruleset, props.document, connection);

	if (!result.ok) {
		emit('connect-rejected', { code: result.code, message: result.message });
		return;
	}

	emit('command', { kind: 'addEdge', ...connection, type: result.type });
});

flow.onEdgeUpdate(({ edge: flowEdge, connection: flowConnection }) => {
	if (!gesture || gesture.cancelled || props.readOnly) return;
	gesture.handled = true;

	const edge = edgeById.value.get(fromFlowId(flowEdge.id));
	if (!edge) return;

	const connection = toDocumentConnection(flowConnection);
	const result = reconnectVerdict(edge, connection);

	if (!result.ok) {
		emit('connect-rejected', { code: result.code, message: result.message });
		return;
	}

	const unchanged =
		edge.source === connection.source &&
		edge.sourceHandle === connection.sourceHandle &&
		edge.target === connection.target &&
		edge.targetHandle === connection.targetHandle;

	if (!unchanged) emit('command', { kind: 'reconnectEdge', id: edge.id, ...connection });
});

/*
 * Released over a port that refused the connection: Vue Flow emits no
 * `connect`, so explain why (canvas-contract.ts). connectEnd is emitted
 * before Vue Flow clears connectionEndHandle (vue-flow-core.mjs:5309, 5315),
 * so the port under the pointer is still known here.
 */
flow.onConnectEnd(() => {
	const drawing = drawState.value;
	const current = gesture;

	if (drawing && current && !current.cancelled && !current.handled) {
		const target = targetHandle.value;
		const verdict = target ? drawing.verdicts.get(target) : undefined;
		if (verdict && !verdict.ok) emit('connect-rejected', { code: verdict.code, message: verdict.message });
	}

	drawState.value = null;
	gesture = null;
});

/**
 * Computes the verdict of every port on the other side of the gesture. For
 * a moved edge end, the edge itself is ignored (it does not block its own
 * new position) and keeps its type where the new source port allows it, as
 * applyCommand's reconnectEdge does (shared/core/commands.ts).
 */
function startDrawing(flowNodeId: string, flowHandleId: string, type: HandleType, reconnect: GraphEdge | null): DrawState {
	const fromNode = fromFlowId(flowNodeId);
	const fromKey = fromFlowId(flowHandleId);
	const candidateType: HandleType = type === 'source' ? 'target' : 'source';
	const verdicts = new Map<string, ConnectResult>();

	for (const [nodeId, nodePorts] of ports.value) {
		const candidates = candidateType === 'target' ? nodePorts.inputs : nodePorts.outputs;

		for (const port of candidates) {
			const connection: Connection =
				type === 'source'
					? { source: fromNode, sourceHandle: fromKey, target: nodeId, targetHandle: port.key }
					: { source: nodeId, sourceHandle: port.key, target: fromNode, targetHandle: fromKey };

			const verdict = reconnect ? reconnectVerdict(reconnect, connection) : canConnect(props.ruleset, props.document, connection);
			verdicts.set(handleKey(toFlowId(nodeId), candidateType, toFlowId(port.key)), verdict);
		}
	}

	const startPorts = ports.value.get(fromNode);
	const startPort = (type === 'source' ? startPorts?.outputs : startPorts?.inputs)?.find((port) => port.key === fromKey);

	return {
		fromNode: flowNodeId,
		fromHandle: flowHandleId,
		fromType: type,
		reconnectEdgeId: reconnect?.id ?? null,
		color: startPort?.color ?? 'var(--theme--primary)',
		verdicts,
	};
}

function reconnectVerdict(edge: GraphEdge, connection: Connection): ConnectResult {
	const options = { ignoreEdgeId: edge.id };
	const result = canConnect(props.ruleset, props.document, { ...connection, type: edge.type ?? props.ruleset.defaultEdgeType }, options);

	if (!result.ok && (result.code === 'edge_type_not_allowed' || result.code === 'unknown_edge_type')) {
		return canConnect(props.ruleset, props.document, connection, options);
	}

	return result;
}

/**
 * The validator every Handle gets (`is-valid-connection`). Vue Flow calls the
 * starting handle's validator for each port the pointer nears (isValidHandle,
 * vue-flow-core.mjs:4562-4611), so an invalid port is never snapped to and
 * releasing over it emits no `connect`.
 */
function isValidConnection(flowConnection: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }): boolean {
	if (props.readOnly) return false;

	const drawing = drawState.value;

	if (drawing) {
		const key =
			drawing.fromType === 'source'
				? handleKey(flowConnection.target, 'target', flowConnection.targetHandle ?? '')
				: handleKey(flowConnection.source, 'source', flowConnection.sourceHandle ?? '');

		const verdict = drawing.verdicts.get(key);
		if (verdict) return verdict.ok;
	}

	return canConnect(props.ruleset, props.document, toDocumentConnection(flowConnection)).ok;
}

function toDocumentConnection(flowConnection: FlowConnection | { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }): Connection {
	return {
		source: fromFlowId(flowConnection.source),
		sourceHandle: fromFlowId(flowConnection.sourceHandle),
		target: fromFlowId(flowConnection.target),
		targetHandle: fromFlowId(flowConnection.targetHandle),
	};
}

/* Palette drops ------------------------------------------------------------------ */

function onDragOver(event: DragEvent) {
	if (props.readOnly || !event.dataTransfer?.types.includes(PALETTE_DRAG_MIME)) return;

	event.preventDefault();
	event.dataTransfer.dropEffect = 'copy';
}

/** The dropped card's header is centred on the pointer, then snapped like a dragged card. */
function onDrop(event: DragEvent) {
	if (props.readOnly) return;

	const type = event.dataTransfer?.getData(PALETTE_DRAG_MIME);
	if (!type) return;

	event.preventDefault();

	const point = toCanvasPoint(event.clientX, event.clientY);
	const position = snap({ x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEADER_HEIGHT / 2 });

	emit('command', { kind: 'addNode', type, position });
}

function toCanvasPoint(clientX: number, clientY: number): Position {
	const rect = (flow.vueFlowRef.value ?? rootRef.value)?.getBoundingClientRect();
	const { x, y, zoom } = flow.viewport.value;

	return {
		x: (clientX - (rect?.left ?? 0) - x) / zoom,
		y: (clientY - (rect?.top ?? 0) - y) / zoom,
	};
}

function snap(position: Position): Position {
	if (!props.snapToGrid) return { x: Math.round(position.x), y: Math.round(position.y) };

	const grid = props.gridSize;
	return { x: Math.round(position.x / grid) * grid, y: Math.round(position.y / grid) * grid };
}

/* Keyboard on focused cards and edges --------------------------------------------- */

/*
 * Vue Flow's own element keyboard handling is disabled (disableKeyboardA11y):
 * it would select, unselect on Escape and move nodes without going through
 * the shell. These keys reproduce the useful part through the contract:
 * Enter or Space on a focused card or edge selects it, and arrow keys move
 * the selected cards by one grid step (a moveNodes command, one undo step
 * per press). Delete, Escape and undo stay with the shell.
 */
const ARROWS: Record<string, Position> = {
	ArrowUp: { x: 0, y: -1 },
	ArrowDown: { x: 0, y: 1 },
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 },
};

function onKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || isEditableTarget(event.target) || !(event.target instanceof Element)) return;

	const element = event.target.closest('.vue-flow__node, .vue-flow__edge');
	if (!element || !rootRef.value?.contains(element)) return;

	const elementId = element.getAttribute('data-id');
	if (!elementId) return;

	const kind = element.classList.contains('vue-flow__node') ? 'node' : 'edge';
	const id = fromFlowId(elementId);

	if (event.key === 'Enter' || event.key === ' ') {
		event.preventDefault();
		const next: Selection = { kind, ids: [id] };
		if (!sameSelection(next, props.selection)) emit('select', next);
		return;
	}

	const direction = ARROWS[event.key];
	if (!direction || kind !== 'node' || props.readOnly) return;

	event.preventDefault();

	// Move the selection if the focused card is part of it, otherwise just the focused card.
	const ids = selectedNodes.value.has(id) ? [...selectedNodes.value] : [id];
	// One grid step when snapping (landing on a grid line, like a drag), else 1px or 10px with Shift.
	const step = props.snapToGrid ? props.gridSize : event.shiftKey ? 10 : 1;

	const moves = ids
		.map((nodeId) => nodeById.value.get(nodeId))
		.filter((node): node is GraphNode => node !== undefined)
		.map((node) => ({
			id: node.id,
			position: snap({ x: node.position.x + direction.x * step, y: node.position.y + direction.y * step }),
		}));

	if (moves.length > 0) emit('command', { kind: 'moveNodes', moves, final: true });
}

/* Errors ------------------------------------------------------------------------- */

/*
 * Vue Flow reports problems through its error hook; its default handler
 * only warns in development builds (vue-flow-core.mjs:4656-4664, 6110), and
 * the extension is built for production. Keep them visible in the console.
 */
flow.onError((error) => {
	// eslint-disable-next-line no-console
	console.warn(`${LOG_PREFIX} ${error.message}`);
});

/* Contract: exposed methods -------------------------------------------------------- */

function animation(): number {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return ANIMATION_MS;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ANIMATION_MS;
}

const expose: CanvasExpose = {
	fitView() {
		void flow.fitView({ padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: animation() });
	},

	zoomIn() {
		void flow.zoomIn({ duration: animation() });
	},

	zoomOut() {
		void flow.zoomOut({ duration: animation() });
	},

	focusElement(kind, id) {
		const zoom = flow.viewport.value.zoom;
		let center: Position | null = null;

		if (kind === 'node') {
			const node = flow.findNode(toFlowId(id));

			if (node) {
				const width = node.dimensions.width || NODE_WIDTH;
				const height = node.dimensions.height || NODE_HEADER_HEIGHT;
				center = { x: node.computedPosition.x + width / 2, y: node.computedPosition.y + height / 2 };
			}
		} else {
			const edge = flow.findEdge(toFlowId(id));

			if (edge && Number.isFinite(edge.sourceX) && Number.isFinite(edge.targetX)) {
				center = { x: (edge.sourceX + edge.targetX) / 2, y: (edge.sourceY + edge.targetY) / 2 };
			} else {
				// A dangling edge is not drawn: show whichever end node still exists.
				const documentEdge = edgeById.value.get(id);
				const end = documentEdge ? (flow.findNode(toFlowId(documentEdge.source)) ?? flow.findNode(toFlowId(documentEdge.target))) : null;
				if (end) center = { x: end.computedPosition.x + NODE_WIDTH / 2, y: end.computedPosition.y + NODE_HEADER_HEIGHT / 2 };
			}
		}

		if (center) void flow.setCenter(center.x, center.y, { zoom, duration: animation() });
	},

	getViewportCenter() {
		const { width, height } = flow.dimensions.value;
		const { x, y, zoom } = flow.viewport.value;
		return { x: (width / 2 - x) / zoom, y: (height / 2 - y) / zoom };
	},

	/*
	 * Escape while drawing: end the line now. Vue Flow keeps its document
	 * listeners until the button is released and may still emit `connect` or
	 * `edgeUpdate` then (useHandle onPointerUp, vue-flow-core.mjs:5298-5321),
	 * so the gesture is marked cancelled and those events are ignored.
	 */
	cancelInteraction() {
		if (!drawState.value && !flow.connectionStartHandle.value) return false;

		if (gesture) gesture.cancelled = true;
		drawState.value = null;
		flow.endConnection();
		return true;
	},
};

defineExpose(expose);

onBeforeUnmount(() => {
	clearTimeout(initFallback);
	if (viewportFrame) cancelAnimationFrame(viewportFrame);
});

/** Minimap cards: theme classes, so the fill follows the selection and the theme (docs/design.md §8.2). */
function minimapNodeClass(node: FlowNode): string {
	return node.selected ? 'ng-minimap__node ng-minimap__node--selected' : 'ng-minimap__node';
}
</script>

<script lang="ts">
/** Counts canvas mounts in this page, for unique Vue Flow store ids. */
let mountSequence = 0;
</script>

<template>
	<div
		ref="rootRef"
		class="ng-canvas ng-vueflow"
		:class="{ 'ng-vueflow--drawing': drawState !== null }"
		@dragover="onDragOver"
		@drop="onDrop"
		@keydown="onKeydown"
	>
		<div class="ng-grid" :class="{ 'ng-grid--hidden': gridHidden }" :style="gridStyle" aria-hidden="true" />

		<VueFlow
			:id="flowId"
			class="ng-vueflow__flow"
			:node-types="nodeTypes"
			:edge-types="edgeTypes"
			:connection-mode="ConnectionMode.Strict"
			:connection-radius="CONNECTION_RADIUS"
			:connect-on-click="false"
			:delete-key-code="null"
			:zoom-activation-key-code="null"
			:pan-activation-key-code="null"
			:disable-keyboard-a11y="true"
			:nodes-draggable="!readOnly"
			:nodes-connectable="!readOnly"
			:edges-updatable="!readOnly"
			:elements-selectable="true"
			:elevate-nodes-on-select="true"
			:elevate-edges-on-select="false"
			:snap-to-grid="snapToGrid"
			:snap-grid="[gridSize, gridSize]"
			:min-zoom="MIN_ZOOM"
			:max-zoom="MAX_ZOOM"
			:default-viewport="initialViewport"
			:zoom-on-double-click="false"
			:pan-on-scroll="false"
			:prevent-scrolling="true"
		>
			<template #connection-line="line">
				<ConnectionPath v-bind="line" />
			</template>

			<MiniMap
				v-if="showMinimap"
				class="ng-minimap"
				position="bottom-right"
				:width="200"
				:height="135"
				pannable
				zoomable
				node-color="var(--ng-minimap-node)"
				node-stroke-color="transparent"
				:node-stroke-width="0"
				:node-border-radius="4"
				:node-class-name="minimapNodeClass"
				mask-color="var(--ng-minimap-mask)"
				aria-label="Minimap"
			/>
		</VueFlow>
	</div>
</template>
