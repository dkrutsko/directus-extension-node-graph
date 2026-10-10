/**
 * The contract between the editor shell and the canvas that draws the graph.
 *
 * The shell (drawer, palette, inspector, issues, history, keyboard, apply and
 * cancel) knows nothing about the graph library. The canvas component
 * (src/canvas/VueFlowCanvas.vue) is the only code that does, and this narrow
 * seam is what keeps it that way: the library could be replaced (Vue Flow 2,
 * say) by writing another canvas against this file, without touching the
 * shell, the rules engine or the stored data.
 *
 * Rules for a canvas implementation:
 *
 * - The document prop is the source of truth. Render from it, and reconcile
 *   incrementally when it changes (undo/redo replaces it wholesale). Never
 *   mutate it and never keep data the library does not understand only
 *   inside the library's own model.
 * - Never drop elements. Nodes whose type is unknown to the ruleset render
 *   as a placeholder card, and edges whose port is unknown still render
 *   (attached to a fallback anchor) so nothing is lost on the next Apply.
 *   For Vue Flow specifically: do NOT set the store-level
 *   `isValidConnection`, because it drops edges on load; validate only while
 *   the user is drawing a connection.
 * - Every user change becomes a GraphCommand emitted through `command`.
 *   Moves emit `moveNodes` with `final: false` while dragging and one
 *   `final: true` on drop.
 * - Validate a connection while it is being drawn with `canConnect()` from
 *   core: invalid targets must look invalid (dimmed handle, danger colour),
 *   and on release an invalid connection is not emitted; emit
 *   `connect-rejected` with the reason instead so the shell can show it.
 * - Disable the library's own keyboard handling (delete keys, undo, select
 *   all). The shell owns the keyboard and turns keys into commands.
 * - Accept palette drops: the palette sets `PALETTE_DRAG_MIME` on its
 *   dataTransfer with the node type key; the canvas converts the drop point
 *   to canvas units and emits `addNode`.
 * - Honour `readOnly`: no dragging, connecting, deleting or dropping, but
 *   selection, panning and zooming still work so the graph can be explored.
 * - Show issues: a small error/warning badge on affected nodes, and
 *   danger/warning styling on affected edges.
 * - Look like Directus (docs/design.md): theme tokens only, no library
 *   default theme left visible, light and dark mode.
 * - Scope every DOM lookup and every global CSS rule to the canvas root (one
 *   page can host several graph fields, and other extensions may load the
 *   same library with its own styles).
 */
import type { Component } from 'vue';
import type { GraphCommand, GraphDocument, Issue, IssueCode, Position, ReferenceResolver } from '../core/types';
import type { CompiledRuleset } from '../core';

export const PALETTE_DRAG_MIME = 'application/x-directus-node-graph-type';

export interface Selection {
	kind: 'node' | 'edge';
	ids: string[];
}

/**
 * Display text of item references (src/shared/ui/references.ts). Pass
 * `resolve` to the core text helpers (nodeTitle, nodeSummary, edgeLabel,
 * canConnect's options) so references read as the referenced item's name.
 * The shell replaces the object whenever labels arrive (`version` changes),
 * and `resolve` reads that version too, so anything rendered from it updates.
 */
export interface ReferenceLabels {
	resolve: ReferenceResolver;
	version: number;
}

export interface CanvasProps {
	document: GraphDocument;
	ruleset: CompiledRuleset;
	readOnly: boolean;
	selection: Selection | null;
	issues: Issue[];
	snapToGrid: boolean;
	gridSize: number;
	showMinimap: boolean;
	/** Unique per editor instance; use it for library instance ids and DOM ids. */
	instanceId: string;
	/** Optional; without it, item references show their keys. */
	references?: ReferenceLabels | null;
}

export interface CanvasEmits {
	command: [command: GraphCommand];
	select: [selection: Selection | null];
	'connect-rejected': [reason: { code: IssueCode; message: string }];
	/** Emitted once the library has mounted and the first fitView has run. */
	ready: [];
}

/** Exposed with defineExpose() and called by the shell's header buttons. */
export interface CanvasExpose {
	fitView(): void;
	zoomIn(): void;
	zoomOut(): void;
	/** Pan so the element is centred, without changing the selection. */
	focusElement(kind: 'node' | 'edge', id: string): void;
	/** Centre of the visible area in canvas units, used when a palette item is clicked rather than dragged. */
	getViewportCenter(): Position;
	/**
	 * Optional. Abort a gesture in progress (a connection being drawn, a
	 * marquee, a drag) and return true, or return false when nothing was in
	 * progress. Escape works from the inside out: the shell calls this first;
	 * only if it returns false (or is not implemented) does Escape clear the
	 * selection, and only when there is no selection either does it reach the
	 * drawer, which then asks to discard unapplied changes and closes.
	 */
	cancelInteraction?(): boolean;
}

/** What the interface entry passes to the shell's interface component. */
export interface CanvasRegistration {
	/** The interface id, e.g. 'node-graph'. Used for the root's data attribute and console messages. */
	interfaceId: string;
	component: Component;
}
