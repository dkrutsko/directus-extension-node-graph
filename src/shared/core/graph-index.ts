/**
 * Lookup structures over one document, built in O(nodes + edges) and shared
 * by canConnect (called on every pointer move while a connection is drawn)
 * and validateDocument.
 */

import { getPorts } from './ports';
import type { CompiledRuleset, GraphDocument, GraphEdge, GraphNode, PairRule, ResolvedPort } from './types';

export interface PortMaps {
	inputs: Map<string, ResolvedPort>;
	outputs: Map<string, ResolvedPort>;
}

export interface GraphIndex {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** First node per id (duplicates are reported by validation, not indexed). */
	nodeById: Map<string, GraphNode>;
	/** Declared ports of every indexed node, by key. */
	portsById: Map<string, PortMaps>;
	/** Edges whose source and target both exist, by source id. */
	outgoing: Map<string, GraphEdge[]>;
	/** Edges per `portKey(node, port)` on the output side and on the input side. */
	outputUse: Map<string, number>;
	inputUse: Map<string, number>;
	/** Edges per `connectionKey()` (same source port and target port). */
	connectionUse: Map<string, number>;
}

/** Separator that cannot appear in a JSON-sourced id by accident. */
const SEPARATOR = '\u0000';

export function portKey(nodeId: string, port: string): string {
	return nodeId + SEPARATOR + port;
}

export function connectionKey(source: string, sourceHandle: string, target: string, targetHandle: string): string {
	return source + SEPARATOR + sourceHandle + SEPARATOR + target + SEPARATOR + targetHandle;
}

interface CacheEntry {
	ruleset: CompiledRuleset;
	nodes: unknown;
	edges: unknown;
	nodeCount: number;
	edgeCount: number;
	index: GraphIndex;
}

/**
 * One index per document object. Documents are immutable by contract (the
 * shell replaces them through applyCommand), but the entry also remembers the
 * array identities and lengths so an accidental in-place push rebuilds it
 * instead of answering from stale data.
 */
const cache = new WeakMap<object, CacheEntry>();

export function indexDocument(ruleset: CompiledRuleset, document: GraphDocument): GraphIndex {
	const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
	const edges = Array.isArray(document?.edges) ? document.edges : [];

	const cached = document && typeof document === 'object' ? cache.get(document) : undefined;

	if (
		cached &&
		cached.ruleset === ruleset &&
		cached.nodes === document.nodes &&
		cached.edges === document.edges &&
		cached.nodeCount === nodes.length &&
		cached.edgeCount === edges.length
	) {
		return cached.index;
	}

	const index = buildIndex(ruleset, nodes, edges);

	if (document && typeof document === 'object') {
		cache.set(document, {
			ruleset,
			nodes: document.nodes,
			edges: document.edges,
			nodeCount: nodes.length,
			edgeCount: edges.length,
			index,
		});
	}

	return index;
}

function buildIndex(ruleset: CompiledRuleset, nodes: GraphNode[], edges: GraphEdge[]): GraphIndex {
	const nodeById = new Map<string, GraphNode>();
	const portsById = new Map<string, PortMaps>();

	for (const node of nodes) {
		if (!node || typeof node.id !== 'string' || nodeById.has(node.id)) continue;

		nodeById.set(node.id, node);

		const ports = getPorts(ruleset, node);

		portsById.set(node.id, {
			inputs: new Map(ports.inputs.map((port) => [port.key, port])),
			outputs: new Map(ports.outputs.map((port) => [port.key, port])),
		});
	}

	const outgoing = new Map<string, GraphEdge[]>();
	const outputUse = new Map<string, number>();
	const inputUse = new Map<string, number>();
	const connectionUse = new Map<string, number>();

	for (const edge of edges) {
		if (!edge) continue;

		const sourcePorts = portsById.get(edge.source);
		const targetPorts = portsById.get(edge.target);

		if (sourcePorts && targetPorts) {
			let list = outgoing.get(edge.source);

			if (!list) {
				list = [];
				outgoing.set(edge.source, list);
			}

			list.push(edge);
		}

		// Count an edge against every declared port it occupies, even when the
		// edge is otherwise invalid: it still uses the port's capacity.
		if (sourcePorts?.outputs.has(edge.sourceHandle)) increment(outputUse, portKey(edge.source, edge.sourceHandle));
		if (targetPorts?.inputs.has(edge.targetHandle)) increment(inputUse, portKey(edge.target, edge.targetHandle));

		increment(connectionUse, connectionKey(edge.source, edge.sourceHandle, edge.target, edge.targetHandle));
	}

	return { nodes, edges, nodeById, portsById, outgoing, outputUse, inputUse, connectionUse };
}

function increment(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Whether `to` can be reached from `from` along existing edges, ignoring one
 * edge (the one being reconnected). Iterative BFS, O(nodes + edges).
 */
export function reaches(index: GraphIndex, from: string, to: string, ignoreEdgeId?: string): boolean {
	if (from === to) return true;

	const seen = new Set<string>([from]);
	const queue = [from];

	for (let head = 0; head < queue.length; head++) {
		for (const edge of index.outgoing.get(queue[head]!) ?? []) {
			if (edge.id === ignoreEdgeId) continue;
			if (edge.target === to) return true;

			if (!seen.has(edge.target)) {
				seen.add(edge.target);
				queue.push(edge.target);
			}
		}
	}

	return false;
}

/** '*' or omitted matches anything; `field.*` matches every dynamic output of that repeater field. */
function matchesPort(pattern: string | undefined, key: string): boolean {
	if (pattern === undefined || pattern === '*' || pattern === key) return true;
	return pattern.endsWith('.*') && key.startsWith(pattern.slice(0, -1));
}

function matchesType(pattern: string | undefined, key: string): boolean {
	return pattern === undefined || pattern === '*' || pattern === key;
}

/**
 * The pair rule that forbids this connection, if any: in 'deny' mode the
 * first matching rule, in 'allow' mode a synthetic rule when none matches.
 */
export function pairViolation(
	ruleset: CompiledRuleset,
	sourceType: string,
	sourcePort: string,
	targetType: string,
	targetPort: string,
): PairRule | null {
	const pairs = ruleset.connectionRules.pairs;
	if (!pairs || !Array.isArray(pairs.rules)) return null;

	const match = pairs.rules.find(
		(rule) =>
			matchesType(rule.source, sourceType) &&
			matchesPort(rule.sourcePort, sourcePort) &&
			matchesType(rule.target, targetType) &&
			matchesPort(rule.targetPort, targetPort),
	);

	if (pairs.mode === 'deny') return match ?? null;
	return match ? null : {};
}
