/**
 * State shared between the Vue Flow canvas and the components Vue Flow
 * renders for it (NodeCard, EdgePath, ConnectionPath).
 *
 * Vue Flow only ever holds ids, positions and an aria label for each element
 * (see VueFlowCanvas.vue, "Reconciling"). Everything a card or an edge shows
 * (type, title, summary, ports, issues, selection) is read from the graph
 * document through this context instead, so the document stays the single
 * source of truth (canvas-contract.ts) and nothing the library does not
 * understand is ever kept only inside its model.
 *
 * The node and edge components are rendered by Vue Flow inside our own
 * <VueFlow>, so they inherit the canvas's provide() and the app context:
 * the SDK compiles `<v-icon>` to resolveComponent('v-icon') against the
 * shared `vue`, which finds the app's global registrations
 * (directus-11.17.4/app/src/components/register.ts), so global components
 * such as v-icon and directives such as v-tooltip resolve as usual.
 */

import type { ComputedRef, InjectionKey, Ref } from 'vue';
import type { CompiledRuleset, ConnectResult, GraphDocument, GraphEdge, GraphNode, Issue, NodePorts, ResolvedPort } from '../shared/core';

/** Vue Flow's handle types: outputs are 'source' handles, inputs 'target' handles. */
export type HandleType = 'source' | 'target';

/** Issues of one element, split by severity, with the texts for the badge tooltips. */
export interface ElementIssues {
	errors: number;
	warnings: number;
	errorText: string;
	warningText: string;
}

/**
 * A connection being drawn, or an edge end being dragged to a new port.
 * `verdicts` holds the canConnect() result for every port the gesture could
 * end on, keyed by handleKey(), computed once when the gesture starts.
 */
export interface DrawState {
	/** Flow id of the node the gesture started from (the fixed end when reconnecting). */
	fromNode: string;
	/** Flow handle id the gesture started from. */
	fromHandle: string;
	fromType: HandleType;
	/** Document id of the edge whose end is being moved, or null for a new connection. */
	reconnectEdgeId: string | null;
	/** CSS colour of the port the line starts at. */
	color: string;
	verdicts: Map<string, ConnectResult>;
}

export interface CanvasContext {
	ruleset: ComputedRef<CompiledRuleset>;
	document: ComputedRef<GraphDocument>;
	readOnly: ComputedRef<boolean>;
	nodeById: ComputedRef<Map<string, GraphNode>>;
	edgeById: ComputedRef<Map<string, GraphEdge>>;
	/** getDocumentPorts(): declared ports plus placeholders for ports that edges reference but nodes do not declare. */
	ports: ComputedRef<Map<string, NodePorts>>;
	/** portKey() of every port with at least one edge. */
	connectedPorts: ComputedRef<Set<string>>;
	/** Node-level issues (issues that name the node and no edge). */
	nodeIssues: ComputedRef<Map<string, ElementIssues>>;
	/** Worst severity per edge. */
	edgeSeverity: ComputedRef<Map<string, 'error' | 'warning'>>;
	/** Per node id: the keys of its ports named by an error (max/min connections, unknown port), joined with \u0000. */
	portsWithIssues: ComputedRef<Map<string, string>>;
	/** The same for warnings (min_connections by default), so those rings are drawn in the warning colour. */
	portsWithWarnings: ComputedRef<Map<string, string>>;
	selectedNodes: ComputedRef<Set<string>>;
	selectedEdges: ComputedRef<Set<string>>;
	drawing: Ref<DrawState | null>;
	/** handleKey() of the handle under the pointer while drawing, from Vue Flow's connectionEndHandle. */
	targetHandle: ComputedRef<string | null>;
	/** Shared Handle validator (canvas-contract.ts: validate while drawing with canConnect). */
	isValidConnection: (connection: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }) => boolean;
	/** Selects an edge as if it had been clicked (used by the label pill). */
	selectEdge: (flowEdgeId: string) => void;
}

export const CANVAS_CONTEXT: InjectionKey<CanvasContext> = Symbol('node-graph-canvas');

/* Ids -------------------------------------------------------------------- */

/*
 * Vue Flow builds `[data-id="<flow>-<node>-<handle>-<type>"]` attribute
 * selectors from node and handle ids while a connection is drawn
 * (isValidHandle, @vue-flow/core 1.48.2 dist/vue-flow-core.mjs:4574), and
 * document ids and placeholder port keys are free text: a `"` in one would
 * make querySelector throw mid-drag. Every id handed to Vue Flow therefore
 * goes through encodeURIComponent, which leaves no character that can end a
 * quoted attribute value. It is a bijection, so ids come back unchanged; the
 * ids the editor generates (`n_…`, `e_…`) and ruleset port keys are not
 * altered at all.
 */
export function toFlowId(id: string): string {
	return encodeURIComponent(id);
}

export function fromFlowId(id: string | null | undefined): string {
	if (!id) return '';

	try {
		return decodeURIComponent(id);
	} catch {
		return id;
	}
}

/** Key of one handle in DrawState.verdicts, in flow ids. */
export function handleKey(flowNodeId: string, type: HandleType, flowHandleId: string): string {
	return `${flowNodeId}\u0000${type}\u0000${flowHandleId}`;
}

/** Key of one port in connectedPorts, in document ids (port keys are unique per direction only). */
export function portKey(nodeId: string, direction: ResolvedPort['direction'], key: string): string {
	return `${nodeId}\u0000${direction}\u0000${key}`;
}

/* Card geometry (docs/design.md §5.1, §6.1) -------------------------------- */

export const NODE_WIDTH = 252;
export const NODE_HEADER_HEIGHT = 54;
/** Centre of the first port row, measured from the top of the card. */
export const PORTS_OFFSET = 72;
export const PORT_ROW = 18;
/** Spacing of top and bottom ports along the card edge (two grid units). */
export const PORT_SPACING_HORIZONTAL = 36;
/** The chevron tip stops this far before the target handle's outer edge (9px before its centre). */
export const MARKER_GAP = 2;
export const MARKER_SIZE = 8;
/** Flows corner radius (app/src/utils/vector2.ts:40, flows/components/arrows/utils/generate-corner.ts). */
export const STEP_CORNER_RADIUS = 10;

/**
 * Where a handle sits on the card, as inline offsets for the Vue Flow handle
 * element. Vue Flow's own CSS centres `.vue-flow__handle-left|right` on the
 * card edge with `top: 50%` and a -50% translate (style.css:200-210), so only
 * the coordinate along the edge is overridden here:
 *   left/right ports at y = 72 + 18·i,
 *   top/bottom ports at x = 126 + 36·(i − (n − 1) / 2).
 */
export function handleOffset(side: ResolvedPort['side'], index: number, count: number): Record<string, string> {
	if (side === 'left' || side === 'right') {
		return { top: `${PORTS_OFFSET + PORT_ROW * index}px` };
	}

	return { left: `${NODE_WIDTH / 2 + PORT_SPACING_HORIZONTAL * (index - (count - 1) / 2)}px` };
}

/**
 * The open chevron of a Flows arrow (arrows/lib/generate-path.ts:60-69): two
 * 8px arms at 45° whose tip is (x, y), opening away from the direction the
 * edge arrives in. `position` is the side of the target card the edge
 * enters through.
 */
export function chevronPath(x: number, y: number, position: string): string {
	const s = MARKER_SIZE;

	switch (position) {
		case 'right':
			return `M ${x + s} ${y - s} L ${x} ${y} L ${x + s} ${y + s}`;
		case 'top':
			return `M ${x - s} ${y - s} L ${x} ${y} L ${x + s} ${y - s}`;
		case 'bottom':
			return `M ${x - s} ${y + s} L ${x} ${y} L ${x + s} ${y + s}`;
		default:
			return `M ${x - s} ${y - s} L ${x} ${y} L ${x - s} ${y + s}`;
	}
}

/**
 * Moves a point `distance` px out of a card side, away from the card: used to
 * stop the edge (and its chevron tip) short of the target handle.
 */
export function offsetFromSide(x: number, y: number, position: string, distance: number): { x: number; y: number } {
	switch (position) {
		case 'right':
			return { x: x + distance, y };
		case 'top':
			return { x, y: y - distance };
		case 'bottom':
			return { x, y: y + distance };
		default:
			return { x: x - distance, y };
	}
}

/** Text for a badge tooltip: one message per line, at most `limit` lines. */
export function issueTooltip(issues: Issue[], limit = 8): string {
	const lines = issues.slice(0, limit).map((issue) => issue.message);
	if (issues.length > limit) lines.push(`… and ${issues.length - limit} more`);
	return lines.join('\n');
}
