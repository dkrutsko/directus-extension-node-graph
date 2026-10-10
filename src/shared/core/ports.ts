/**
 * Port resolution: turns a node type's declared ports (plus outputs generated
 * from a repeater field) into ResolvedPorts with every default filled in.
 */

import type {
	CompiledRuleset,
	DynamicOutputs,
	GraphDocument,
	GraphEdge,
	GraphNode,
	NodeGraphField,
	NodeTypeDef,
	PortDef,
	PortSide,
	ResolvedPort,
} from './types';
import { renderTemplate } from './template';
import { collapseWhitespace, isPlainObject } from './util';

/** The implicit data type of ports that declare none. Accepts and is accepted by everything. */
export const ANY_DATA_TYPE = 'any';

/** Colour of ports whose data type has no colour. */
export const NEUTRAL_PORT_COLOR = 'var(--theme--foreground-subdued)';

/** Colour of placeholder ports (referenced by an edge, not declared). */
export const UNDECLARED_PORT_COLOR = 'var(--theme--danger)';

/**
 * Ports of one node. The arrays and port objects are frozen (they are cached
 * and shared between renders); copy before changing anything.
 */
export interface NodePorts {
	inputs: ResolvedPort[];
	outputs: ResolvedPort[];
}

const EMPTY_PORTS: NodePorts = freezePorts([], []);

/**
 * Declared ports per compiled ruleset and node object. Documents are
 * immutable (applyCommand returns new node objects only for nodes it
 * changes), so a node object's ports never change and canvases can call
 * getPorts on every render for free. Results are frozen for the same reason.
 */
const declaredCache = new WeakMap<CompiledRuleset, WeakMap<object, NodePorts>>();

/**
 * The ports of `node`: inputs, then outputs (static and dynamic in the order
 * set by `dynamicOutputs.placement`). Nodes of unknown type have none.
 *
 * Pass the document's `edges` to also get a placeholder port (`declared:
 * false`) for every handle an edge references that the node does not
 * declare, so the edge can still be drawn instead of being dropped. For a
 * whole document prefer `getDocumentPorts()`, which does this in one pass.
 */
export function getPorts(ruleset: CompiledRuleset, node: GraphNode, edges?: readonly GraphEdge[] | null): NodePorts {
	const declared = getDeclaredPorts(ruleset, node);
	if (!edges || edges.length === 0) return declared;

	const missingInputs = new Set<string>();
	const missingOutputs = new Set<string>();

	for (const edge of edges) {
		if (!edge) continue;
		if (edge.target === node.id) collectMissing(declared.inputs, edge.targetHandle, missingInputs);
		if (edge.source === node.id) collectMissing(declared.outputs, edge.sourceHandle, missingOutputs);
	}

	return withPlaceholders(ruleset, declared, missingInputs, missingOutputs);
}

/** getPorts for every node of a document, with placeholders, in O(nodes + edges). Keyed by node id (first node wins for duplicate ids). */
export function getDocumentPorts(ruleset: CompiledRuleset, document: GraphDocument): Map<string, NodePorts> {
	const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
	const edges = Array.isArray(document?.edges) ? document.edges : [];

	const declared = new Map<string, NodePorts>();

	for (const node of nodes) {
		if (node && !declared.has(node.id)) declared.set(node.id, getDeclaredPorts(ruleset, node));
	}

	const missing = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();

	const missingFor = (id: string) => {
		let entry = missing.get(id);

		if (!entry) {
			entry = { inputs: new Set(), outputs: new Set() };
			missing.set(id, entry);
		}

		return entry;
	};

	for (const edge of edges) {
		if (!edge) continue;

		const targetPorts = declared.get(edge.target);
		if (targetPorts) collectMissing(targetPorts.inputs, edge.targetHandle, missingFor(edge.target).inputs);

		const sourcePorts = declared.get(edge.source);
		if (sourcePorts) collectMissing(sourcePorts.outputs, edge.sourceHandle, missingFor(edge.source).outputs);
	}

	const result = new Map<string, NodePorts>();

	for (const [id, ports] of declared) {
		const entry = missing.get(id);
		result.set(id, entry ? withPlaceholders(ruleset, ports, entry.inputs, entry.outputs) : ports);
	}

	return result;
}

/** Whether a target port of `targetType` accepts a source port of `sourceType`. */
export function dataTypeAccepts(ruleset: CompiledRuleset, targetType: string, sourceType: string): boolean {
	if (targetType === ANY_DATA_TYPE || sourceType === ANY_DATA_TYPE || targetType === sourceType) return true;

	const target = ruleset.dataTypeMap.get(targetType);
	if (!target) return false;

	return target.acceptSet.has(sourceType) || target.acceptSet.has(ANY_DATA_TYPE);
}

/** Default side for a direction, from the ruleset's layout direction. */
export function defaultSide(ruleset: Pick<CompiledRuleset, 'direction'>, direction: 'input' | 'output'): PortSide {
	if (ruleset.direction === 'TB') return direction === 'input' ? 'top' : 'bottom';
	return direction === 'input' ? 'left' : 'right';
}

/** Edge types allowed to start at an output, default first. */
export function portEdgeTypes(ruleset: CompiledRuleset, def: Pick<PortDef, 'edgeTypes'>): string[] {
	if (Array.isArray(def.edgeTypes) && def.edgeTypes.length > 0) {
		return def.edgeTypes.filter((key) => ruleset.edgeTypeMap.has(key));
	}

	// "Omitted means all", with the ruleset default first so new edges get it.
	const keys = ruleset.edgeTypes.map((type) => type.key);
	return [ruleset.defaultEdgeType, ...keys.filter((key) => key !== ruleset.defaultEdgeType)];
}

function getDeclaredPorts(ruleset: CompiledRuleset, node: GraphNode): NodePorts {
	if (!node || typeof node !== 'object') return EMPTY_PORTS;

	let perRuleset = declaredCache.get(ruleset);

	if (!perRuleset) {
		perRuleset = new WeakMap();
		declaredCache.set(ruleset, perRuleset);
	}

	const cached = perRuleset.get(node);
	if (cached) return cached;

	const ports = resolveDeclaredPorts(ruleset, node);
	perRuleset.set(node, ports);
	return ports;
}

function resolveDeclaredPorts(ruleset: CompiledRuleset, node: GraphNode): NodePorts {
	const type = ruleset.nodeTypeMap.get(node.type);
	if (!type) return EMPTY_PORTS;

	const inputs = (type.inputs ?? []).map((def) => resolvePort(ruleset, def, 'input', def.label, false));
	const staticOutputs = (type.outputs ?? []).map((def) => resolvePort(ruleset, def, 'output', def.label, false));

	let outputs = staticOutputs;

	if (type.dynamicOutputs) {
		// A static key always wins over a generated one with the same key.
		const staticKeys = new Set(staticOutputs.map((port) => port.key));

		const dynamic = dynamicPorts(ruleset, type, type.dynamicOutputs, node).filter(
			(port) => !staticKeys.has(port.key),
		);

		outputs = type.dynamicOutputs.placement === 'start' ? [...dynamic, ...staticOutputs] : [...staticOutputs, ...dynamic];
	}

	return freezePorts(inputs, outputs);
}

function freezePorts(inputs: ResolvedPort[], outputs: ResolvedPort[]): NodePorts {
	Object.freeze(inputs);
	Object.freeze(outputs);
	return Object.freeze({ inputs, outputs });
}

/**
 * One output per item of the repeater field, keyed `${field}.${index}`.
 * Index keys are a documented limitation: reordering items re-targets edges.
 */
function dynamicPorts(
	ruleset: CompiledRuleset,
	type: NodeTypeDef,
	dynamic: DynamicOutputs,
	node: GraphNode,
): ResolvedPort[] {
	const data = isPlainObject(node.data) ? node.data : {};
	const items = data[dynamic.field];
	if (!Array.isArray(items)) return [];

	// The repeater's own sub-field definitions, so select values in the label show their choice text.
	const repeater = (type.fields ?? []).find((field) => field.field === dynamic.field);
	const subFields = repeater?.meta?.options?.['fields'];
	const labelFields = Array.isArray(subFields) ? (subFields as NodeGraphField[]) : null;

	return items.map((item, index) => {
		let label = '';

		if (dynamic.labelTemplate) {
			label = collapseWhitespace(renderTemplate(dynamic.labelTemplate, item, labelFields));
		} else if (typeof item === 'string' || typeof item === 'number') {
			label = collapseWhitespace(String(item));
		}

		const def: PortDef = { ...(dynamic.port ?? {}), key: `${dynamic.field}.${index}` };
		return resolvePort(ruleset, def, 'output', label || `#${index + 1}`, true);
	});
}

function resolvePort(
	ruleset: CompiledRuleset,
	def: PortDef,
	direction: 'input' | 'output',
	label: string | undefined,
	dynamic: boolean,
): ResolvedPort {
	const dataType = def.dataType ?? ANY_DATA_TYPE;
	const compiledType = ruleset.dataTypeMap.get(dataType);

	return Object.freeze({
		key: def.key,
		label: label || def.key,
		direction,
		side: def.side ?? defaultSide(ruleset, direction),
		dataType,
		dataTypeLabel: compiledType?.label ?? (dataType === ANY_DATA_TYPE ? 'Any' : dataType),
		color: compiledType?.color ?? NEUTRAL_PORT_COLOR,
		minConnections: def.minConnections ?? 0,
		maxConnections: def.maxConnections ?? null,
		edgeTypes: direction === 'output' ? portEdgeTypes(ruleset, def) : [],
		dynamic,
		declared: true,
	});
}

function collectMissing(ports: ResolvedPort[], handle: unknown, into: Set<string>): void {
	if (typeof handle !== 'string') return;
	if (into.has(handle)) return;
	if (ports.some((port) => port.key === handle)) return;
	into.add(handle);
}

function withPlaceholders(
	ruleset: CompiledRuleset,
	declared: NodePorts,
	missingInputs: Set<string>,
	missingOutputs: Set<string>,
): NodePorts {
	if (missingInputs.size === 0 && missingOutputs.size === 0) return declared;

	return freezePorts(
		[...declared.inputs, ...[...missingInputs].map((key) => placeholder(ruleset, key, 'input'))],
		[...declared.outputs, ...[...missingOutputs].map((key) => placeholder(ruleset, key, 'output'))],
	);
}

function placeholder(ruleset: CompiledRuleset, key: string, direction: 'input' | 'output'): ResolvedPort {
	return Object.freeze({
		key,
		label: key === '' ? '?' : key,
		direction,
		side: defaultSide(ruleset, direction),
		dataType: ANY_DATA_TYPE,
		dataTypeLabel: 'Any',
		color: UNDECLARED_PORT_COLOR,
		minConnections: 0,
		maxConnections: null,
		edgeTypes: [],
		dynamic: false,
		declared: false,
	});
}
