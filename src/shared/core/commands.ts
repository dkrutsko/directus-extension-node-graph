/**
 * The only way the editor changes a document. Canvases emit GraphCommands;
 * the shell applies them here and pushes the result onto its undo history.
 *
 * applyCommand is pure: it never mutates its input and returns a new
 * document with structural sharing (untouched nodes and edges keep their
 * object identity, which keeps the port and index caches warm). When a
 * command changes nothing (unknown id, rejected connection, a no-op move) it
 * returns the input document itself, so `next === previous` tells the shell
 * not to record a history entry.
 */

import { canConnect } from './connect';
import { fieldDefaults } from './document';
import { canonicalJson } from './hash';
import { generateId } from './ids';
import { getPorts } from './ports';
import type { CompiledRuleset, GraphCommand, GraphDocument, GraphEdge, GraphNode, Position, Viewport } from './types';
import { FORBIDDEN_KEYS, VERSIONING_KEYS, cloneJson, hasOwn, isFiniteNumber, isPlainObject, isUsableId, setOwn } from './util';

export function applyCommand(ruleset: CompiledRuleset, document: GraphDocument, command: GraphCommand): GraphDocument {
	// Commands come from canvas event handlers; a stray undefined must not take the editor down.
	if (!command || typeof command !== 'object') return document;

	switch (command.kind) {
		case 'addNode':
			return addNode(ruleset, document, command);
		case 'moveNodes':
			return moveNodes(document, command.moves);
		case 'removeElements':
			return removeElements(ruleset, document, command.nodeIds, command.edgeIds);
		case 'addEdge':
			return addEdge(ruleset, document, command);
		case 'reconnectEdge':
			return reconnectEdge(ruleset, document, command);
		case 'updateNodeData':
			return updateNodeData(document, command.id, command.data);
		case 'updateEdge':
			return updateEdge(ruleset, document, command);
		case 'setViewport':
			return setViewport(document, command.viewport);
		default:
			return document;
	}
}

/**
 * Adds a node of a known type with its field defaults (`schema.default_value`)
 * merged under `data`. Refused (document returned unchanged) for unknown
 * types, for types already at `limits.maxInstances` while `max_instances` is
 * an error (the palette disables them too) and for an `id` that is already
 * taken or that normalizeDocument would not keep (empty, too long, or
 * reserved such as `__proto__`): such a node would vanish, with its edges,
 * the next time the value is read. Deprecated types are accepted; only the
 * palette hides them.
 */
function addNode(
	ruleset: CompiledRuleset,
	document: GraphDocument,
	command: Extract<GraphCommand, { kind: 'addNode' }>,
): GraphDocument {
	const type = ruleset.nodeTypeMap.get(command.type);
	if (!type) return document;

	// Like canConnect, only a limit the ruleset treats as an error blocks: with
	// `severity.max_instances` at 'warning' or 'off' the server accepts the extra node.
	const max = type.limits?.maxInstances;

	if (
		max !== undefined &&
		ruleset.severities.max_instances === 'error' &&
		document.nodes.filter((node) => node.type === type.key).length >= max
	) {
		return document;
	}

	const id = command.id ?? generateId('n');
	if (!isUsableId(id)) return document;
	if (document.nodes.some((node) => node.id === id) || document.edges.some((edge) => edge.id === id)) return document;

	const position = toPosition(command.position);
	if (!position) return document;

	const node: GraphNode = {
		id,
		type: type.key,
		position,
		data: { ...fieldDefaults(type.fields), ...cleanData(command.data) },
	};

	return { ...document, nodes: [...document.nodes, node] };
}

/** Moves nodes; positions that are not finite numbers and unknown ids are ignored. */
function moveNodes(document: GraphDocument, moves: Array<{ id: string; position: Position }>): GraphDocument {
	const targets = new Map<string, Position>();

	for (const move of moves ?? []) {
		const position = toPosition(move?.position);
		if (position) targets.set(move.id, position);
	}

	let changed = false;

	const nodes = document.nodes.map((node) => {
		const position = targets.get(node.id);
		if (!position || (position.x === node.position.x && position.y === node.position.y)) return node;

		changed = true;
		return { ...node, position };
	});

	return changed ? { ...document, nodes } : document;
}

/**
 * Removes nodes (and every edge attached to them) and edges. Nodes whose
 * type says `deletable: false` are kept; nodes of unknown types can always
 * be removed.
 */
function removeElements(ruleset: CompiledRuleset, document: GraphDocument, nodeIds: string[], edgeIds: string[]): GraphDocument {
	const removeNodes = new Set<string>();

	for (const id of nodeIds ?? []) {
		const node = document.nodes.find((candidate) => candidate.id === id);
		if (node && ruleset.nodeTypeMap.get(node.type)?.deletable !== false) removeNodes.add(id);
	}

	const removeEdges = new Set(edgeIds ?? []);

	const nodes = document.nodes.filter((node) => !removeNodes.has(node.id));

	const edges = document.edges.filter(
		(edge) => !removeEdges.has(edge.id) && !removeNodes.has(edge.source) && !removeNodes.has(edge.target),
	);

	if (nodes.length === document.nodes.length && edges.length === document.edges.length) return document;

	return { ...document, nodes, edges };
}

/**
 * Adds an edge if canConnect allows it, with the edge type it resolves and
 * that type's field defaults merged under `data`.
 */
function addEdge(
	ruleset: CompiledRuleset,
	document: GraphDocument,
	command: Extract<GraphCommand, { kind: 'addEdge' }>,
): GraphDocument {
	const connection = {
		source: command.source,
		sourceHandle: command.sourceHandle,
		target: command.target,
		targetHandle: command.targetHandle,
		...(command.type !== undefined ? { type: command.type } : {}),
	};

	const result = canConnect(ruleset, document, connection);
	if (!result.ok) return document;

	const id = command.id ?? generateId('e');
	if (!isUsableId(id)) return document;
	if (document.edges.some((edge) => edge.id === id) || document.nodes.some((node) => node.id === id)) return document;

	const edgeType = ruleset.edgeTypeMap.get(result.type);

	const edge: GraphEdge = {
		id,
		type: result.type,
		source: command.source,
		sourceHandle: command.sourceHandle,
		target: command.target,
		targetHandle: command.targetHandle,
		data: { ...fieldDefaults(edgeType?.fields), ...cleanData(command.data) },
	};

	return { ...document, edges: [...document.edges, edge] };
}

/**
 * Moves an edge's endpoints. The edge keeps its type when the new source port
 * allows it, otherwise it takes the new port's default type. Refused when the
 * new endpoints fail canConnect (ignoring the edge itself).
 */
function reconnectEdge(
	ruleset: CompiledRuleset,
	document: GraphDocument,
	command: Extract<GraphCommand, { kind: 'reconnectEdge' }>,
): GraphDocument {
	const index = document.edges.findIndex((edge) => edge.id === command.id);
	if (index === -1) return document;

	const existing = document.edges[index]!;
	const endpoints = {
		source: command.source,
		sourceHandle: command.sourceHandle,
		target: command.target,
		targetHandle: command.targetHandle,
	};

	const options = { ignoreEdgeId: existing.id };
	let result = canConnect(ruleset, document, { ...endpoints, type: existing.type ?? ruleset.defaultEdgeType }, options);

	if (!result.ok && (result.code === 'edge_type_not_allowed' || result.code === 'unknown_edge_type')) {
		result = canConnect(ruleset, document, endpoints, options);
	}

	if (!result.ok) return document;

	const unchanged =
		existing.source === endpoints.source &&
		existing.sourceHandle === endpoints.sourceHandle &&
		existing.target === endpoints.target &&
		existing.targetHandle === endpoints.targetHandle &&
		existing.type === result.type;

	if (unchanged) return document;

	const edges = [...document.edges];
	edges[index] = { ...existing, ...endpoints, type: result.type };
	return { ...document, edges };
}

/**
 * Shallow-merges `data` into a node's data (what the inspector's VForm emits
 * as edits). Setting a key to null clears it; keys are never deleted, which
 * matches how Directus stores cleared form values. A patch that only repeats
 * current values returns the document itself: VForm re-emits its whole edits
 * object on every change, and the shell relies on `next === previous` to skip
 * history entries and to know there is nothing to discard.
 */
function updateNodeData(document: GraphDocument, id: string, data: Record<string, unknown>): GraphDocument {
	const index = document.nodes.findIndex((node) => node.id === id);
	if (index === -1) return document;

	const node = document.nodes[index]!;
	const patch = changedEntries(node.data, cleanData(data));
	if (!patch) return document;

	const nodes = [...document.nodes];
	nodes[index] = { ...node, data: { ...node.data, ...patch } };
	return { ...document, nodes };
}

/**
 * Changes an edge's type (only to a type the source port allows) and/or
 * shallow-merges `data` into its data. A disallowed type is ignored.
 */
function updateEdge(
	ruleset: CompiledRuleset,
	document: GraphDocument,
	command: Extract<GraphCommand, { kind: 'updateEdge' }>,
): GraphDocument {
	const index = document.edges.findIndex((edge) => edge.id === command.id);
	if (index === -1) return document;

	const existing = document.edges[index]!;
	const next: GraphEdge = { ...existing };
	let changed = false;

	if (command.type !== undefined && command.type !== existing.type && ruleset.edgeTypeMap.has(command.type)) {
		if (edgeTypeAllowed(ruleset, document, existing, command.type)) {
			next.type = command.type;
			changed = true;

			// Fill defaults of the new type's fields that the edge does not have yet.
			const defaults = fieldDefaults(ruleset.edgeTypeMap.get(command.type)?.fields);
			if (Object.keys(defaults).length > 0) next.data = { ...defaults, ...(existing.data ?? {}) };
		}
	}

	if (command.data !== undefined) {
		const patch = changedEntries(next.data, cleanData(command.data));

		if (patch) {
			next.data = { ...(next.data ?? {}), ...patch };
			changed = true;
		}
	}

	if (!changed) return document;

	const edges = [...document.edges];
	edges[index] = next;
	return { ...document, edges };
}

function setViewport(document: GraphDocument, viewport: Viewport): GraphDocument {
	if (!viewport || !isFiniteNumber(viewport.x) || !isFiniteNumber(viewport.y) || !isFiniteNumber(viewport.zoom) || viewport.zoom <= 0) {
		return document;
	}

	const current = document.viewport;
	if (current && current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) return document;

	return { ...document, viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } };
}

/**
 * Whether `edge` may take the edge type `type`: the type must be one its
 * source port allows (while `edge_type_not_allowed` is an error). Judged on
 * the port directly rather than through canConnect, which stops at the first
 * failing check: an edge that is already a self loop or over a port limit
 * would otherwise never reach the edge type check and could take any type.
 * An edge whose source port cannot be resolved (unknown node type or port,
 * missing node) has no list to judge against and may change its type.
 */
function edgeTypeAllowed(ruleset: CompiledRuleset, document: GraphDocument, edge: GraphEdge, type: string): boolean {
	if (ruleset.severities.edge_type_not_allowed !== 'error') return true;

	const source = document.nodes.find((node) => node.id === edge.source);
	if (!source || !ruleset.nodeTypeMap.has(source.type)) return true;

	const output = getPorts(ruleset, source).outputs.find((port) => port.key === edge.sourceHandle);
	return !output || output.edgeTypes.includes(type);
}

/**
 * The entries of `patch` whose value differs from `current` (compared as
 * canonical JSON, so key order inside objects does not count), or null when
 * there are none. A key `current` does not have counts as a change, even to
 * null, because it changes the stored JSON.
 */
function changedEntries(current: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> | null {
	const base = isPlainObject(current) ? current : {};
	const result: Record<string, unknown> = {};
	let changed = false;

	for (const key of Object.keys(patch)) {
		if (hasOwn(base, key) && canonicalJson(base[key]) === canonicalJson(patch[key])) continue;

		setOwn(result, key, patch[key]);
		changed = true;
	}

	return changed ? result : null;
}

function toPosition(value: unknown): Position | null {
	if (!isPlainObject(value) || !isFiniteNumber(value['x']) || !isFiniteNumber(value['y'])) return null;
	return { x: value['x'], y: value['y'] };
}

/**
 * Deep copy of incoming data without forbidden or versioning keys, so form
 * values (possibly reactive proxies) never end up shared with the document.
 */
function cleanData(data: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!isPlainObject(data)) return {};

	const result: Record<string, unknown> = {};

	for (const key of Object.keys(data)) {
		if (FORBIDDEN_KEYS.has(key) || VERSIONING_KEYS.has(key)) continue;

		const value = cloneJson(data[key]);
		setOwn(result, key, value === undefined ? null : value);
	}

	return result;
}
