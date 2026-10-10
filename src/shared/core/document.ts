/**
 * The field value: reading it safely (normalizeDocument) and creating new
 * ones (emptyDocument, starterDocument).
 *
 * normalizeDocument is the single entry point for untrusted values: whatever
 * the form, the API, "Edit raw value", the AI assistant or a content version
 * hands us. It never throws, strips content-versioning stamps, rejects
 * prototype keys, coerces shapes and preserves everything it does not
 * understand (unknown node types, ports and keys), so nothing is lost on the
 * next save. Its output is canonical: normalising the JSON of a normalised
 * document gives byte-identical JSON.
 */

import { generateId } from './ids';
import { getPorts } from './ports';
import type {
	CompiledRuleset,
	GraphDocument,
	GraphEdge,
	GraphMeta,
	GraphNode,
	NodeGraphField,
	NormalizeResult,
	Position,
	Viewport,
} from './types';
import {
	FORBIDDEN_KEYS,
	RESERVED_NAMES,
	VERSIONING_KEYS,
	cloneJson,
	echo,
	isFiniteNumber,
	isNonNegativeInteger,
	isPlainObject,
	isUsableId,
	sanitizeJson,
	setOwn,
	type SanitizeOptions,
} from './util';

export const DOCUMENT_FORMAT = 'directus-node-graph';
export const DOCUMENT_VERSION = 1;

const DOCUMENT_KEYS = new Set(['format', 'version', 'ruleset', 'nodes', 'edges', 'viewport', 'meta']);
const NODE_KEYS = new Set(['id', 'type', 'position', 'data']);
const EDGE_KEYS = new Set(['id', 'type', 'source', 'sourceHandle', 'target', 'targetHandle', 'data']);

export function emptyDocument(): GraphDocument {
	return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, nodes: [], edges: [] };
}

/**
 * Accepts null, a JSON string or an object and returns a well-formed
 * document plus a list of what had to be repaired. Never throws.
 *
 * - null, undefined and '' give an empty document with no problems.
 * - `_user` / `_date` are removed at every depth without a problem (content
 *   versioning adds them; see util.ts).
 * - `__proto__`, `constructor` and `prototype` keys are removed and reported
 *   as fatal.
 * - Nodes without a usable id and edges without endpoints are removed and
 *   reported as fatal. Ids, endpoints and port keys that name a member of
 *   Object.prototype (`__proto__`, `constructor`, `toString`, ...; see
 *   RESERVED_NAMES) are not usable: they end up as keys of plain objects.
 *   Everything else is coerced (missing position → 0,0, missing data → {},
 *   numeric ids, types and port keys → strings) and reported as a repair,
 *   unless a value had to be thrown away, which is fatal.
 * - Unknown node types, unknown ports, dangling edges and duplicate ids are
 *   kept untouched: they are validation issues, not normalisation problems.
 */
export function normalizeDocument(raw: unknown): NormalizeResult {
	const problems: string[] = [];
	const fatal: string[] = [];

	const repair = (message: string) => problems.push(message);

	const lose = (message: string) => {
		problems.push(message);
		fatal.push(message);
	};

	try {
		const document = normalize(raw, repair, lose);
		return { document, problems, fatal };
	} catch {
		// Defensive: a throwing getter or a revoked proxy. Nothing usable survives.
		lose('The value could not be read.');
		return { document: emptyDocument(), problems, fatal };
	}
}

function normalize(raw: unknown, repair: (message: string) => void, lose: (message: string) => void): GraphDocument {
	let value = raw;

	if (value === null || value === undefined) return emptyDocument();

	if (typeof value === 'string') {
		if (value.trim() === '') return emptyDocument();

		try {
			value = JSON.parse(value);
		} catch {
			lose('The value is not valid JSON.');
			return emptyDocument();
		}

		if (value === null) return emptyDocument();
	}

	if (!isPlainObject(value)) {
		lose('The value is not a graph document (expected an object).');
		return emptyDocument();
	}

	const source = value;

	if (source['format'] === undefined) {
		if (!Array.isArray(source['nodes']) && !Array.isArray(source['edges'])) {
			lose('The value is not a graph document (no "format", "nodes" or "edges").');
			return emptyDocument();
		}

		repair('The "format" marker was missing and has been added.');
	} else if (source['format'] !== DOCUMENT_FORMAT) {
		lose(`The value has format "${echo(source['format'])}", not "${DOCUMENT_FORMAT}".`);
		return emptyDocument();
	}

	if (source['version'] === undefined) {
		repair('The document version was missing and has been set to 1.');
	} else if (source['version'] !== DOCUMENT_VERSION) {
		lose(`Document version ${echo(source['version'])} is not supported (expected ${DOCUMENT_VERSION}).`);
		return emptyDocument();
	}

	// Paths are built from keys of the incoming value; keep them readable.
	const sanitize: SanitizeOptions = {
		stripVersioningKeys: true,
		report: (path, problem) => {
			const where = truncatePath(path);
			if (problem === 'forbidden_key') lose(`${where}: the key is not allowed and was removed.`);
			else if (problem === 'too_deep') lose(`${where}: nested too deeply; the value was removed.`);
			else lose(`${where}: not a JSON value; it was removed.`);
		},
	};

	const document: GraphDocument = { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, nodes: [], edges: [] };

	const stamp = normalizeStamp(source['ruleset']);
	if (stamp) document.ruleset = stamp;
	else if (source['ruleset'] !== undefined && source['ruleset'] !== null) repair('The ruleset stamp was malformed and has been removed.');

	document.nodes = normalizeNodes(source['nodes'], sanitize, repair, lose);
	document.edges = normalizeEdges(source['edges'], sanitize, repair, lose);

	const viewport = normalizeViewport(source['viewport']);
	if (viewport) document.viewport = viewport;
	else if (source['viewport'] !== undefined && source['viewport'] !== null) repair('The viewport was malformed and has been reset.');

	// meta is derived and recomputed on every Apply and write; keep it only
	// when it is well-formed, so a display can still read it cheaply.
	const meta = normalizeMeta(source['meta']);
	if (meta) document.meta = meta;

	// Preserve unknown top-level keys after the known ones, in input order.
	for (const key of Object.keys(source)) {
		if (DOCUMENT_KEYS.has(key) || VERSIONING_KEYS.has(key)) continue;

		if (FORBIDDEN_KEYS.has(key)) {
			lose(`${key}: the key is not allowed and was removed.`);
			continue;
		}

		const child = sanitizeJson(source[key], key, sanitize, 1);
		if (child !== undefined) setOwn(document as unknown as Record<string, unknown>, key, child);
	}

	return document;
}

function normalizeId(value: unknown): string | null {
	const id = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
	return isUsableId(id) ? id : null;
}

/**
 * A key-like member (node type, edge type, port key): strings stay, finite
 * numbers become strings (`"type": 5` → `"5"`, a valid key), null and
 * undefined are missing. Anything else cannot be kept and is `invalid`.
 */
function normalizeKey(value: unknown): { key: string | null; invalid: boolean } {
	if (typeof value === 'string') return { key: value, invalid: false };
	if (typeof value === 'number' && Number.isFinite(value)) return { key: String(value), invalid: false };
	return { key: null, invalid: value !== undefined && value !== null };
}

/** Problem paths contain keys of the incoming value; a crafted key must not make the message huge. */
function truncatePath(path: string): string {
	return path.length > 120 ? `${path.slice(0, 120)}…` : path;
}

function normalizeNodes(
	value: unknown,
	sanitize: SanitizeOptions,
	repair: (message: string) => void,
	lose: (message: string) => void,
): GraphNode[] {
	if (value === undefined || value === null) return [];

	if (!Array.isArray(value)) {
		lose('"nodes" is not a list; it was removed.');
		return [];
	}

	const nodes: GraphNode[] = [];

	value.forEach((raw, index) => {
		const path = `nodes[${index}]`;

		if (!isPlainObject(raw)) {
			lose(`${path}: not an object; it was removed.`);
			return;
		}

		const id = normalizeId(raw['id']);

		if (id === null) {
			lose(`${path}: no usable id; the node was removed.`);
			return;
		}

		if (typeof raw['id'] === 'number') repair(`Node ${id}: the numeric id was converted to text.`);

		const normalizedType = normalizeKey(raw['type']);
		let type = normalizedType.key ?? '';

		if (normalizedType.invalid) {
			lose(`Node ${id}: the type is not text; it was cleared.`);
		} else if (normalizedType.key === null) {
			repair(`Node ${id}: the type was missing.`);
		} else if (FORBIDDEN_KEYS.has(type)) {
			lose(`Node ${id}: the type "${type}" is not allowed and was cleared.`);
			type = '';
		} else if (typeof raw['type'] === 'number') {
			repair(`Node ${id}: the numeric type was converted to text.`);
		}

		const position = normalizePosition(raw['position']);
		if (!position) repair(`Node ${id}: the position was missing or malformed and has been set to (0, 0).`);

		let data: Record<string, unknown> = {};

		if (isPlainObject(raw['data'])) {
			data = sanitizeJson(raw['data'], `${path}.data`, sanitize, 2) as Record<string, unknown>;
		} else if (raw['data'] !== undefined && raw['data'] !== null) {
			lose(`Node ${id}: "data" is not an object; it was replaced with an empty one.`);
		}

		const node: GraphNode = { id, type, position: position ?? { x: 0, y: 0 }, data };
		preserveUnknownKeys(raw, node as unknown as Record<string, unknown>, NODE_KEYS, path, sanitize, lose);
		nodes.push(node);
	});

	return nodes;
}

function normalizeEdges(
	value: unknown,
	sanitize: SanitizeOptions,
	repair: (message: string) => void,
	lose: (message: string) => void,
): GraphEdge[] {
	if (value === undefined || value === null) return [];

	if (!Array.isArray(value)) {
		lose('"edges" is not a list; it was removed.');
		return [];
	}

	const edges: GraphEdge[] = [];

	value.forEach((raw, index) => {
		const path = `edges[${index}]`;

		if (!isPlainObject(raw)) {
			lose(`${path}: not an object; it was removed.`);
			return;
		}

		const id = normalizeId(raw['id']);

		if (id === null) {
			lose(`${path}: no usable id; the connection was removed.`);
			return;
		}

		const source = normalizeId(raw['source']);
		const target = normalizeId(raw['target']);

		if (source === null || target === null) {
			lose(`Connection ${id}: the source or target is missing or not a usable id; the connection was removed.`);
			return;
		}

		if (typeof raw['id'] === 'number') repair(`Connection ${id}: the numeric id was converted to text.`);
		if (typeof raw['source'] === 'number' || typeof raw['target'] === 'number') repair(`Connection ${id}: a numeric node reference was converted to text.`);

		const handle = (member: 'sourceHandle' | 'targetHandle'): string => {
			const { key, invalid } = normalizeKey(raw[member]);

			if (invalid) {
				lose(`Connection ${id}: the ${member} is not text; it was cleared.`);
				return '';
			}

			if (key === null) {
				repair(`Connection ${id}: the ${member} was missing.`);
				return '';
			}

			// Port keys end up as keys of plain objects (see RESERVED_NAMES).
			if (RESERVED_NAMES.has(key)) {
				lose(`Connection ${id}: the ${member} "${key}" is not allowed and was cleared.`);
				return '';
			}

			if (typeof raw[member] === 'number') repair(`Connection ${id}: the numeric ${member} was converted to text.`);
			return key;
		};

		const sourceHandle = handle('sourceHandle');
		const targetHandle = handle('targetHandle');

		const normalizedType = normalizeKey(raw['type']);
		const type = normalizedType.key === '' ? null : normalizedType.key;

		if (normalizedType.invalid) {
			lose(`Connection ${id}: the type is not text; it was removed.`);
		} else if (typeof raw['type'] === 'number') {
			repair(`Connection ${id}: the numeric type was converted to text.`);
		}

		// Key order: id, type, source, sourceHandle, target, targetHandle, data, then unknown keys.
		const edge: GraphEdge =
			type === null
				? { id, source, sourceHandle, target, targetHandle }
				: { id, type, source, sourceHandle, target, targetHandle };

		if (isPlainObject(raw['data'])) {
			edge.data = sanitizeJson(raw['data'], `${path}.data`, sanitize, 2) as Record<string, unknown>;
		} else if (raw['data'] !== undefined && raw['data'] !== null) {
			lose(`Connection ${id}: "data" is not an object; it was removed.`);
		}

		preserveUnknownKeys(raw, edge as unknown as Record<string, unknown>, EDGE_KEYS, path, sanitize, lose);
		edges.push(edge);
	});

	return edges;
}

function preserveUnknownKeys(
	raw: Record<string, unknown>,
	into: Record<string, unknown>,
	known: Set<string>,
	path: string,
	sanitize: SanitizeOptions,
	lose: (message: string) => void,
): void {
	for (const key of Object.keys(raw)) {
		if (known.has(key) || VERSIONING_KEYS.has(key)) continue;

		if (FORBIDDEN_KEYS.has(key)) {
			lose(`${path}.${key}: the key is not allowed and was removed.`);
			continue;
		}

		const child = sanitizeJson(raw[key], `${path}.${key}`, sanitize, 2);
		if (child !== undefined) setOwn(into, key, child);
	}
}

function normalizePosition(value: unknown): Position | null {
	if (!isPlainObject(value) || !isFiniteNumber(value['x']) || !isFiniteNumber(value['y'])) return null;
	return { x: value['x'], y: value['y'] };
}

function normalizeViewport(value: unknown): Viewport | null {
	if (!isPlainObject(value)) return null;

	const { x, y, zoom } = { x: value['x'], y: value['y'], zoom: value['zoom'] };
	if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom) || zoom <= 0) return null;

	return { x, y, zoom };
}

function normalizeStamp(value: unknown): { key: string; version: number } | null {
	if (!isPlainObject(value)) return null;

	const key = value['key'];
	const version = value['version'];
	if (typeof key !== 'string' || key === '' || !isFiniteNumber(version)) return null;

	return { key, version };
}

function normalizeMeta(value: unknown): GraphMeta | null {
	if (!isPlainObject(value)) return null;

	const numbers = ['nodeCount', 'edgeCount', 'errorCount', 'warningCount'] as const;
	if (!numbers.every((key) => isNonNegativeInteger(value[key]))) return null;
	if (typeof value['graphHash'] !== 'string' || !isPlainObject(value['counts'])) return null;

	const counts: Record<string, number> = {};
	const rawCounts = value['counts'];

	for (const key of Object.keys(rawCounts)) {
		if (FORBIDDEN_KEYS.has(key) || VERSIONING_KEYS.has(key)) continue;
		const count = rawCounts[key];
		if (!isNonNegativeInteger(count)) return null;
		setOwn(counts, key, count);
	}

	return {
		nodeCount: value['nodeCount'] as number,
		edgeCount: value['edgeCount'] as number,
		errorCount: value['errorCount'] as number,
		warningCount: value['warningCount'] as number,
		counts,
		graphHash: value['graphHash'],
	};
}

/**
 * Default values of a node or edge type's fields (`schema.default_value`),
 * deep-copied so two elements never share an object. Null defaults are
 * skipped, as the Directus form does.
 */
export function fieldDefaults(fields: readonly NodeGraphField[] | undefined): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};

	for (const field of fields ?? []) {
		const value = field?.schema?.default_value;
		if (value === undefined || value === null) continue;
		setOwn(defaults, field.field, cloneJson(value));
	}

	return defaults;
}

/**
 * What "Create" seeds: the ruleset's `starter` graph with fresh ids, or,
 * without one, `limits.minInstances` nodes of every (non-deprecated) type
 * that requires them, laid out in a row along the ruleset's direction.
 * Field defaults are filled in and the ruleset stamp is set.
 */
export function starterDocument(ruleset: CompiledRuleset): GraphDocument {
	const document = emptyDocument();
	document.ruleset = { key: ruleset.key, version: ruleset.version };

	const starter = ruleset.starter;

	if (starter && Array.isArray(starter.nodes)) {
		const ids = new Map<string, string>();

		for (const entry of starter.nodes) {
			const type = ruleset.nodeTypeMap.get(entry.type);
			if (!type) continue;

			const id = generateId('n');
			ids.set(entry.ref, id);

			document.nodes.push({
				id,
				type: type.key,
				position: { x: entry.position.x, y: entry.position.y },
				data: { ...fieldDefaults(type.fields), ...cloneJson(entry.data ?? {}) },
			});
		}

		for (const entry of starter.edges ?? []) {
			const source = ids.get(entry.source);
			const target = ids.get(entry.target);
			if (!source || !target) continue;

			const sourceNode = document.nodes.find((node) => node.id === source)!;
			const output = getPorts(ruleset, sourceNode).outputs.find((port) => port.key === entry.sourceHandle);
			const type = entry.type ?? output?.edgeTypes[0] ?? ruleset.defaultEdgeType;
			const edgeType = ruleset.edgeTypeMap.get(type);

			document.edges.push({
				id: generateId('e'),
				type,
				source,
				sourceHandle: entry.sourceHandle,
				target,
				targetHandle: entry.targetHandle,
				data: { ...fieldDefaults(edgeType?.fields), ...cloneJson(entry.data ?? {}) },
			});
		}

		return document;
	}

	// Cards are 252 px wide (--ng-node-width in ui/theme.css), so seeded nodes
	// sit 360 units apart: a 108 px gap that keeps each card's output ports
	// clear of the next card and lands on the 18 px grid (20 cells). With 240
	// the second card covered the first one's outputs.
	const spacing = 360;
	let slot = 0;

	for (const type of ruleset.nodeTypes) {
		if (type.deprecated) continue;

		const count = type.limits?.minInstances ?? 0;

		for (let i = 0; i < count; i++) {
			const offset = slot++ * spacing;

			document.nodes.push({
				id: generateId('n'),
				type: type.key,
				position: ruleset.direction === 'TB' ? { x: 0, y: offset } : { x: offset, y: 0 },
				data: fieldDefaults(type.fields),
			});
		}
	}

	return document;
}
