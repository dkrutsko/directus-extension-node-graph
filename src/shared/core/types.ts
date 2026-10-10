/**
 * Data contracts of the node-graph field.
 *
 * This file is the single source of truth for the data shapes used by the
 * interface, the display and the API hook. It must stay framework-free: no
 * Vue, no DOM, no Node-only APIs, because it is compiled into both the app
 * bundle and the API bundle. docs/ruleset.md documents the formats for
 * people who write rulesets by hand.
 *
 * Three documents, each versioned on its own:
 *
 *   1. NodeGraphFieldOptions: the interface options stored in
 *      directus_fields.meta.options (travels with schema snapshots).
 *   2. Ruleset: the declarative rules (node types, ports, edges, connection
 *      and graph rules). Lives inside the field options, as `ruleset`.
 *   3. GraphDocument: the field value (a json column).
 *
 * Rules are data only. No expression strings, no user regex, no HTML.
 */

/* ------------------------------------------------------------------------ */
/* Field definitions (reused Directus shape)                                */
/* ------------------------------------------------------------------------ */

/**
 * A subset of the Directus field shape. Node and edge fields use it so the
 * editor can render them with the app's global `VForm` (`fields` prop, no
 * collection), the same way the stock Repeater (`list`) interface does.
 *
 * Relational interfaces (m2o, o2m, m2m, m2a, file, files, file-image,
 * translations) cannot work here because they need directus_relations rows.
 */
export interface NodeGraphField {
	field: string;
	name?: string;
	/** Directus field type: string, text, integer, bigInteger, float, decimal, boolean, json, csv, uuid, hash, date, time, dateTime, timestamp. */
	type: string;
	meta?: {
		interface?: string | null;
		options?: Record<string, unknown> | null;
		display?: string | null;
		display_options?: Record<string, unknown> | null;
		width?: 'half' | 'half-left' | 'half-right' | 'full' | 'fill';
		required?: boolean;
		readonly?: boolean;
		hidden?: boolean;
		note?: string | null;
		conditions?: unknown[] | null;
		sort?: number | null;
	} | null;
	schema?: {
		default_value?: unknown;
	} | null;
}

/* ------------------------------------------------------------------------ */
/* Ruleset                                                                  */
/* ------------------------------------------------------------------------ */

export type PortSide = 'left' | 'right' | 'top' | 'bottom';

export interface PortDef {
	/** Stable key, unique among a node type's inputs (or outputs). Used as the edge's sourceHandle/targetHandle. */
	key: string;
	label?: string;
	/** Key into Ruleset.dataTypes. Omitted means 'any'. */
	dataType?: string;
	/** Default: inputs on the 'left' and outputs on the 'right' for direction LR; 'top'/'bottom' for TB. */
	side?: PortSide;
	/** At least this many connections, otherwise a `min_connections` issue (default severity: warning). Default 0. */
	minConnections?: number;
	/** At most this many connections (`max_connections`, error). Omitted means unlimited. 1 means a single connection. */
	maxConnections?: number;
	/** Outputs only: edge types that may start here. The first one is the default for new edges. Omitted means all. */
	edgeTypes?: string[];
}

/**
 * Outputs generated from a node field. The field must be a json field using the
 * stock `list` (Repeater) interface. Each list item becomes one output port with
 * key `${field}.${index}` and a label rendered from `labelTemplate` against the
 * item. Index-based keys are a documented limitation (README, Limitations):
 * reordering items re-targets edges.
 */
export interface DynamicOutputs {
	field: string;
	labelTemplate?: string;
	/** Port settings applied to every generated output. */
	port?: Omit<PortDef, 'key' | 'label'>;
	/** Where the generated outputs go relative to the static ones. Default 'end'. */
	placement?: 'start' | 'end';
}

export interface NodeTypeDef {
	key: string;
	label: string;
	/** Material Symbols name, as used by `<v-icon>`. */
	icon?: string;
	/** Any CSS colour, preferably a Directus theme token such as `var(--theme--primary)`. */
	color?: string;
	description?: string;
	/** Palette group. */
	category?: string;
	/** Hidden from the palette; existing nodes stay valid but raise a `deprecated_node_type` warning. */
	deprecated?: boolean;
	/** Default true. */
	deletable?: boolean;
	limits?: {
		minInstances?: number;
		maxInstances?: number;
	};
	/** Node title. Tokens are the node's field keys plus `$type` (type label). Falls back to the type label when empty. */
	titleTemplate?: string;
	/** Field keys whose values are shown on the node card under the title. */
	summaryFields?: string[];
	fields?: NodeGraphField[];
	inputs?: PortDef[];
	outputs?: PortDef[];
	dynamicOutputs?: DynamicOutputs;
}

export interface EdgeTypeDef {
	key: string;
	label: string;
	style?: {
		path?: 'bezier' | 'step' | 'straight';
		/** Any CSS colour, preferably a Directus theme token. */
		color?: string;
		dashed?: boolean;
		animated?: boolean;
		/** Default 'arrow'. */
		marker?: 'arrow' | 'none';
	};
	/** Edge label. Tokens are the edge's field keys plus `$type`. Empty means no label. */
	labelTemplate?: string;
	fields?: NodeGraphField[];
}

export interface DataTypeDef {
	key: string;
	label?: string;
	color?: string;
	/** Source data types this (target) type also accepts. A type always accepts itself; 'any' accepts and is accepted by everything. */
	accepts?: string[];
}

/** A connection pattern. Omitted members and '*' match anything. */
export interface PairRule {
	source?: string;
	sourcePort?: string;
	target?: string;
	targetPort?: string;
	message?: string;
}

export interface ConnectionRules {
	defaultEdgeType?: string;
	/** Default 'strict': port data types must be compatible. */
	typeCheck?: 'strict' | 'off';
	/** Default false. */
	allowSelfLoops?: boolean;
	/** Default true. */
	allowCycles?: boolean;
	/** Two edges between the same source port and target port. Default false. */
	allowMultiEdges?: boolean;
	/** 'allow': only matching connections are valid. 'deny': matching connections are invalid. */
	pairs?: {
		mode: 'allow' | 'deny';
		rules: PairRule[];
	};
}

export interface GraphRules {
	minNodes?: number;
	maxNodes?: number;
	maxEdges?: number;
	/** Node types that start the graph, used by requireReachableFromEntry. */
	entryNodeTypes?: string[];
	requireReachableFromEntry?: boolean;
	/** Every node has at least one edge. */
	requireConnected?: boolean;
}

export type IssueCode =
	// structural (error)
	| 'invalid_document'
	| 'duplicate_id'
	| 'unknown_node_type'
	| 'unknown_edge_type'
	| 'unknown_port'
	| 'dangling_edge'
	// edge level (error)
	| 'type_mismatch'
	| 'pair_not_allowed'
	| 'self_loop'
	| 'cycle'
	| 'multi_edge'
	| 'max_connections'
	| 'edge_type_not_allowed'
	| 'wrong_direction'
	// counts (error)
	| 'max_instances'
	| 'max_nodes'
	| 'max_edges'
	// node fields (error)
	| 'field_required'
	// completeness (warning by default)
	| 'min_connections'
	| 'min_instances'
	| 'min_nodes'
	| 'not_connected'
	| 'unreachable'
	// lifecycle (warning)
	| 'deprecated_node_type';

export type Severity = 'error' | 'warning' | 'off';

export interface StarterGraph {
	nodes: Array<{ ref: string; type: string; position: Position; data?: Record<string, unknown> }>;
	edges?: Array<{ source: string; sourceHandle: string; target: string; targetHandle: string; type?: string; data?: Record<string, unknown> }>;
}

export interface Ruleset {
	format: 'directus-node-graph-ruleset';
	schemaVersion: 1;
	key: string;
	/** Content revision, bumped by whoever edits the ruleset. */
	version: number;
	name: string;
	/** Default 'LR'. Decides default port sides. */
	direction?: 'LR' | 'TB';
	dataTypes?: DataTypeDef[];
	nodeTypes: NodeTypeDef[];
	edgeTypes?: EdgeTypeDef[];
	connectionRules?: ConnectionRules;
	graphRules?: GraphRules;
	/** Overrides of the built-in severity per issue code. */
	severity?: Partial<Record<IssueCode, Severity>>;
	/** What "Create graph" seeds. When omitted, one node per type with limits.minInstances >= 1 is seeded. `ref` values are local to the starter and replaced by generated ids. */
	starter?: StarterGraph;
}

/* ------------------------------------------------------------------------ */
/* Graph document (the field value)                                         */
/* ------------------------------------------------------------------------ */

export interface Position {
	x: number;
	y: number;
}

export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

export interface GraphNode {
	/** Opaque generated id, never derived from labels. */
	id: string;
	type: string;
	/** Canvas units at zoom 1. */
	position: Position;
	data: Record<string, unknown>;
}

export interface GraphEdge {
	id: string;
	/** Edge type key. Omitted means the ruleset's default edge type. */
	type?: string;
	source: string;
	/** Output port key on the source node. */
	sourceHandle: string;
	target: string;
	/** Input port key on the target node. */
	targetHandle: string;
	data?: Record<string, unknown>;
}

export interface GraphMeta {
	nodeCount: number;
	edgeCount: number;
	errorCount: number;
	warningCount: number;
	/** Node count per node type key. */
	counts: Record<string, number>;
	/** Canonical, position-free hash of nodes (id, type, data) and edges. Moving boxes does not change it. */
	graphHash: string;
}

export interface GraphDocument {
	format: 'directus-node-graph';
	version: 1;
	/** Ruleset the document was last applied/validated against. */
	ruleset?: { key: string; version: number };
	nodes: GraphNode[];
	edges: GraphEdge[];
	viewport?: Viewport;
	/** Derived. Recomputed by the editor on Apply and by the hook on write; never trusted on input. */
	meta?: GraphMeta;
}

/* ------------------------------------------------------------------------ */
/* Validation                                                               */
/* ------------------------------------------------------------------------ */

export interface Issue {
	code: IssueCode;
	severity: 'error' | 'warning';
	message: string;
	nodeId?: string;
	edgeId?: string;
	/** Port key, when the issue concerns a port. */
	port?: string;
	/** Field key, when the issue concerns a node or edge field. */
	field?: string;
	/** Stable identity of the issue, independent of message text, used by the 'ratchet' policy. */
	fingerprint: string;
}

export interface Connection {
	source: string;
	sourceHandle: string;
	target: string;
	targetHandle: string;
	/** Edge type; omitted means the default for the source port. */
	type?: string;
}

export type ConnectResult = { ok: true; type: string } | { ok: false; code: IssueCode; message: string };

/* ------------------------------------------------------------------------ */
/* Editor commands (canvas → shell)                                         */
/* ------------------------------------------------------------------------ */

/**
 * Canvases never mutate the document. They emit commands; the shell applies
 * them with the pure `applyCommand()` from core and pushes the result onto
 * the undo history. The canvas then re-renders from the new document.
 */
export type GraphCommand =
	| { kind: 'addNode'; type: string; position: Position; data?: Record<string, unknown>; id?: string }
	/** `final: false` while dragging (coalesced into one history entry), `final: true` on drop. */
	| { kind: 'moveNodes'; moves: Array<{ id: string; position: Position }>; final: boolean }
	| { kind: 'removeElements'; nodeIds: string[]; edgeIds: string[] }
	| { kind: 'addEdge'; source: string; sourceHandle: string; target: string; targetHandle: string; type?: string; data?: Record<string, unknown>; id?: string }
	| { kind: 'reconnectEdge'; id: string; source: string; sourceHandle: string; target: string; targetHandle: string }
	| { kind: 'updateNodeData'; id: string; data: Record<string, unknown> }
	| { kind: 'updateEdge'; id: string; type?: string; data?: Record<string, unknown> }
	/** Not recorded in the undo history. */
	| { kind: 'setViewport'; viewport: Viewport };

/* ------------------------------------------------------------------------ */
/* Interface options                                                        */
/* ------------------------------------------------------------------------ */

export type EnforcementPolicy = 'ratchet' | 'reject' | 'log' | 'off';

export interface NodeGraphFieldOptions {
	/** The ruleset: an object, edited in the field settings by the options form (src/shared/options-editor); a JSON string written through the API is accepted too. */
	ruleset?: Ruleset | string | null;
	/** Field row and display template. Tokens: nodeCount, edgeCount, errorCount, warningCount, counts.<typeKey>, ruleset.name, ruleset.version. */
	template?: string | null;
	/** Shown when the field is empty. */
	placeholder?: string | null;
	/** Drawer width: 'standard' (stock 770 px), 'wide' (default), 'full'. */
	editorWidth?: 'standard' | 'wide' | 'full' | null;
	/** Server-side enforcement by the hook. Default 'ratchet'. */
	enforcement?: EnforcementPolicy | null;
	snapToGrid?: boolean | null;
	/** Grid size in canvas units. Default 18 (the Flows grid). */
	gridSize?: number | null;
	/** A minimap in the corner of the canvas. Default false. */
	showMinimap?: boolean | null;
}

/* ------------------------------------------------------------------------ */
/* Resolved and compiled forms                                              */
/* ------------------------------------------------------------------------ */

/**
 * A port as the editor draws it: the declared PortDef with every default
 * filled in, dynamic outputs expanded, and the data type's label and colour
 * looked up. Produced by `getPorts()`.
 *
 * Port keys are unique per direction, not across directions: a node type may
 * have an input `a` and an output `a`. Anything that keys a node's ports in
 * one map must include the direction (the Vue Flow canvas keys handles by
 * node, handle type and key: src/canvas/context.ts handleKey and portKey).
 */
export interface ResolvedPort {
	key: string;
	/** Display label: PortDef.label, the rendered dynamic label, or the key. */
	label: string;
	direction: 'input' | 'output';
	side: PortSide;
	/** Data type key; 'any' when the port declares none. */
	dataType: string;
	dataTypeLabel: string;
	/** CSS colour of the data type, or a neutral theme token. */
	color: string;
	minConnections: number;
	/** null means unlimited. */
	maxConnections: number | null;
	/** Outputs: edge types that may start here, default first. Inputs: empty. */
	edgeTypes: string[];
	/** Generated from `dynamicOutputs`. */
	dynamic: boolean;
	/**
	 * false for a placeholder that `getPorts(ruleset, node, edges)` adds when an
	 * edge references a port the node does not declare (unknown type, removed
	 * port, deleted repeater item), so the edge can still be drawn.
	 */
	declared: boolean;
}

/** A data type with defaults filled in and its `accepts` list as a set. */
export interface CompiledDataType extends DataTypeDef {
	label: string;
	color: string;
	acceptSet: Set<string>;
}

/** Connection rules with every default filled in. */
export interface CompiledConnectionRules extends ConnectionRules {
	defaultEdgeType: string;
	typeCheck: 'strict' | 'off';
	allowSelfLoops: boolean;
	allowCycles: boolean;
	allowMultiEdges: boolean;
}

/**
 * A checked ruleset with defaults filled in and lookup maps built, produced by
 * `compileRuleset()`. It is a deep copy: later changes to the raw ruleset (for
 * example a reactive options object) never leak into it. Treat it as
 * read-only.
 */
export interface CompiledRuleset extends Ruleset {
	direction: 'LR' | 'TB';
	dataTypes: DataTypeDef[];
	/** Never empty: a ruleset without edge types gets one synthesised 'default' type. */
	edgeTypes: EdgeTypeDef[];
	connectionRules: CompiledConnectionRules;
	graphRules: GraphRules;
	nodeTypeMap: Map<string, NodeTypeDef>;
	edgeTypeMap: Map<string, EdgeTypeDef>;
	dataTypeMap: Map<string, CompiledDataType>;
	defaultEdgeType: string;
	/** Built-in severities with `severity` overrides applied. */
	severities: Record<IssueCode, Severity>;
}

/**
 * Result of `normalizeDocument()`. `problems` lists every repair in plain
 * text. `fatal` is the subset where data could not be kept as it was (the
 * value was not a graph, an element was removed, a forbidden key was
 * dropped); `validateValue()` reports each one as an `invalid_document` issue.
 */
export interface NormalizeResult {
	document: GraphDocument;
	problems: string[];
	fatal: string[];
}

/** Result of `validateValue()`: the raw field value normalised and validated in one step. */
export interface ValueReport {
	/** null when the raw value was null or undefined (an empty field). */
	document: GraphDocument | null;
	issues: Issue[];
	problems: string[];
}
