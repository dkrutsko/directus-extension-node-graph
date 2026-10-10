/**
 * Graph validation. The same function drives the editor's live issue list,
 * the field row's issue chip and the hook's server-side enforcement, so the
 * three always agree.
 *
 * Every check is O(nodes + edges): one pass over nodes, one over edges, an
 * iterative Tarjan SCC for cycles and a BFS for reachability. There is no
 * recursion on graph structure, so a long chain cannot overflow the stack.
 */

import { DEFAULT_SEVERITIES } from './compile';
import { DOCUMENT_FORMAT, DOCUMENT_VERSION, normalizeDocument } from './document';
import { connectionKey, indexDocument, pairViolation, portKey, type GraphIndex } from './graph-index';
import { nodeName, plural, portName, typeLabels } from './messages';
import { dataTypeAccepts } from './ports';
import type {
	CompiledRuleset,
	GraphDocument,
	GraphEdge,
	GraphNode,
	Issue,
	IssueCode,
	NodeGraphField,
	ReferenceResolver,
	ValueReport,
} from './types';
import { echo, formatTitle, isPlainObject } from './util';

/** The parts of an issue that identify it, independent of its message text. */
export interface IssueRef {
	code: IssueCode;
	nodeId?: string;
	edgeId?: string;
	port?: string;
	field?: string;
}

/**
 * Stable identity of an issue: code plus the ids it points at, plus an
 * optional detail (port direction, node type, problem text) where the ids
 * alone are ambiguous. Used by the hook's `ratchet` policy to tell errors the
 * stored graph already had from new ones. JSON-encoded so ids containing any
 * character cannot collide.
 */
export function issueFingerprint(ref: IssueRef, detail?: string): string {
	return JSON.stringify([ref.code, ref.nodeId ?? null, ref.edgeId ?? null, ref.port ?? null, ref.field ?? null, detail ?? null]);
}

type Draft = Omit<Issue, 'severity'>;

function draft(ref: IssueRef, message: string, detail?: string): Draft {
	const issue: Draft = { code: ref.code, message, fingerprint: issueFingerprint(ref, detail) };
	if (ref.nodeId !== undefined) issue.nodeId = ref.nodeId;
	if (ref.edgeId !== undefined) issue.edgeId = ref.edgeId;
	if (ref.port !== undefined) issue.port = ref.port;
	if (ref.field !== undefined) issue.field = ref.field;
	return issue;
}

export interface ValidateOptions {
	/**
	 * Display text of item references, for the node titles in messages. The
	 * editor passes its resolver so messages match the cards; the hook passes
	 * none. Messages are never part of a fingerprint, so the issues are the
	 * same either way.
	 */
	references?: ReferenceResolver | null | undefined;
}

/**
 * Validates a document against a compiled ruleset and returns every issue,
 * errors first, then warnings, each group in document order. Issues whose
 * severity is 'off' are left out. Never throws on malformed input: a value
 * that is not a document yields a single `invalid_document` issue (use
 * normalizeDocument or validateValue for raw values).
 */
export function validateDocument(ruleset: CompiledRuleset, document: GraphDocument, options: ValidateOptions = {}): Issue[] {
	const drafts: Draft[] = [];
	const add = (ref: IssueRef, message: string, detail?: string) => drafts.push(draft(ref, message, detail));

	if (!hasDocumentShape(document)) {
		add({ code: 'invalid_document' }, 'The value is not a graph document.', 'shape');
		return finish(ruleset, drafts);
	}

	if (document.format !== DOCUMENT_FORMAT || document.version !== DOCUMENT_VERSION) {
		add({ code: 'invalid_document' }, `The document format is not "${DOCUMENT_FORMAT}" version ${DOCUMENT_VERSION}.`, 'format');
	}

	const index = indexDocument(ruleset, document);
	const { nodes, edges } = index;
	const rules = ruleset.connectionRules;
	const graphRules = ruleset.graphRules;
	const name = (node: GraphNode | undefined) => nodeName(ruleset, node, options.references);

	/* Ids ------------------------------------------------------------------- */

	const seenNodeIds = new Set<string>();

	for (const node of nodes) {
		if (seenNodeIds.has(node.id)) {
			add({ code: 'duplicate_id', nodeId: node.id }, `Node id "${node.id}" is used more than once.`, 'node');
		}

		seenNodeIds.add(node.id);
	}

	const seenEdgeIds = new Set<string>();

	for (const edge of edges) {
		if (seenEdgeIds.has(edge.id)) {
			add({ code: 'duplicate_id', edgeId: edge.id }, `Connection id "${edge.id}" is used more than once.`, 'edge');
		} else if (seenNodeIds.has(edge.id)) {
			add({ code: 'duplicate_id', edgeId: edge.id }, `Id "${edge.id}" is used by both a node and a connection.`, 'shared');
		}

		seenEdgeIds.add(edge.id);
	}

	/* Nodes ----------------------------------------------------------------- */

	const typeCounts = new Map<string, number>();
	const extraOfType = new Map<string, GraphNode>();

	for (const node of nodes) {
		const type = ruleset.nodeTypeMap.get(node.type);

		if (!type) {
			add(
				{ code: 'unknown_node_type', nodeId: node.id },
				node.type === ''
					? `Node ${node.id} has no type.`
					: `Node ${node.id} has the type "${echo(node.type)}", which this ruleset does not define.`,
			);

			continue;
		}

		const count = (typeCounts.get(type.key) ?? 0) + 1;
		typeCounts.set(type.key, count);

		// Remember the first node over the limit, so the issue can select it.
		const max = type.limits?.maxInstances;
		if (max !== undefined && count === max + 1) extraOfType.set(type.key, node);

		if (type.deprecated) {
			add({ code: 'deprecated_node_type', nodeId: node.id }, `${name(node)} uses the deprecated node type "${type.label}".`);
		}

		for (const field of missingRequired(type.fields, node.data)) {
			add(
				{ code: 'field_required', nodeId: node.id, field: field.field },
				`${name(node)}: "${field.name || formatTitle(field.field)}" is required.`,
			);
		}
	}

	/* Edges ----------------------------------------------------------------- */

	const seenConnections = new Set<string>();
	const degree = new Map<string, number>();

	for (const edge of edges) {
		const source = index.nodeById.get(edge.source);
		const target = index.nodeById.get(edge.target);

		if (source) degree.set(source.id, (degree.get(source.id) ?? 0) + 1);
		if (target && target !== source) degree.set(target.id, (degree.get(target.id) ?? 0) + 1);

		if (!source || !target) {
			const missing = !source && !target ? 'both of its nodes are' : !source ? 'its source node is' : 'its target node is';
			add({ code: 'dangling_edge', edgeId: edge.id }, `Connection ${edge.id} is broken: ${missing} missing.`);
			continue;
		}

		const between = `${name(source)} → ${name(target)}`;
		const typeKey = edge.type ?? ruleset.defaultEdgeType;
		const edgeType = ruleset.edgeTypeMap.get(typeKey);

		if (!edgeType) {
			add({ code: 'unknown_edge_type', edgeId: edge.id }, `${between}: the connection type "${echo(typeKey)}" is not defined.`);
		} else {
			for (const field of missingRequired(edgeType.fields, edge.data)) {
				add(
					{ code: 'field_required', edgeId: edge.id, field: field.field },
					`${between}: "${field.name || formatTitle(field.field)}" is required.`,
				);
			}
		}

		if (source.id === target.id && !rules.allowSelfLoops) {
			add({ code: 'self_loop', edgeId: edge.id, nodeId: source.id }, `${name(source)} is connected to itself.`);
		}

		const sourceType = ruleset.nodeTypeMap.get(source.type);
		const targetType = ruleset.nodeTypeMap.get(target.type);

		// Ports of unknown node types cannot be judged; unknown_node_type already covers them.
		const sourcePorts = index.portsById.get(source.id)!;
		const targetPorts = index.portsById.get(target.id)!;
		const output = sourceType ? sourcePorts.outputs.get(edge.sourceHandle) : undefined;
		const input = targetType ? targetPorts.inputs.get(edge.targetHandle) : undefined;

		const reversed =
			(sourceType && !output && sourcePorts.inputs.has(edge.sourceHandle)) ||
			(targetType && !input && targetPorts.outputs.has(edge.targetHandle));

		if (reversed) {
			add({ code: 'wrong_direction', edgeId: edge.id }, `${between}: the connection runs from an input to an output.`);
		} else {
			if (sourceType && !output) {
				add(
					{ code: 'unknown_port', edgeId: edge.id, nodeId: source.id, port: edge.sourceHandle },
					`${name(source)} has no output "${echo(edge.sourceHandle)}" (connection to ${name(target)}).`,
					'output',
				);
			}

			if (targetType && !input) {
				add(
					{ code: 'unknown_port', edgeId: edge.id, nodeId: target.id, port: edge.targetHandle },
					`${name(target)} has no input "${echo(edge.targetHandle)}" (connection from ${name(source)}).`,
					'input',
				);
			}
		}

		if (!output || !input || !sourceType || !targetType) continue;

		if (edgeType && !output.edgeTypes.includes(edgeType.key)) {
			add(
				{ code: 'edge_type_not_allowed', edgeId: edge.id },
				`${name(source)}: ${portName(output)} does not allow "${edgeType.label}" connections.`,
			);
		}

		if (rules.typeCheck === 'strict' && !dataTypeAccepts(ruleset, input.dataType, output.dataType)) {
			add(
				{ code: 'type_mismatch', edgeId: edge.id },
				`${between}: ${portName(output)} (${output.dataTypeLabel}) cannot connect to ${portName(input)} (${input.dataTypeLabel}).`,
			);
		}

		const violation = pairViolation(ruleset, sourceType.key, output.key, targetType.key, input.key);

		if (violation) {
			add(
				{ code: 'pair_not_allowed', edgeId: edge.id },
				violation.message ? `${between}: ${violation.message}` : `${between}: ${sourceType.label} cannot connect to ${targetType.label}.`,
			);
		}

		const key = connectionKey(source.id, output.key, target.id, input.key);

		if (seenConnections.has(key) && !rules.allowMultiEdges) {
			add({ code: 'multi_edge', edgeId: edge.id }, `${between}: these ports are already connected by another connection.`);
		}

		seenConnections.add(key);
	}

	/* Port connection counts ------------------------------------------------- */

	for (const node of index.nodeById.values()) {
		if (!ruleset.nodeTypeMap.has(node.type)) continue;

		const ports = index.portsById.get(node.id)!;

		for (const [direction, map, use] of [
			['input', ports.inputs, index.inputUse],
			['output', ports.outputs, index.outputUse],
		] as const) {
			for (const port of map.values()) {
				const count = use.get(portKey(node.id, port.key)) ?? 0;

				if (count < port.minConnections) {
					add(
						{ code: 'min_connections', nodeId: node.id, port: port.key },
						`${name(node)}: ${portName(port)} needs at least ${plural(port.minConnections, 'connection')} (has ${count}).`,
						direction,
					);
				}

				if (port.maxConnections !== null && count > port.maxConnections) {
					add(
						{ code: 'max_connections', nodeId: node.id, port: port.key },
						`${name(node)}: ${portName(port)} allows at most ${plural(port.maxConnections, 'connection')} (has ${count}).`,
						direction,
					);
				}
			}
		}
	}

	/* Instance and size limits ---------------------------------------------- */

	for (const type of ruleset.nodeTypes) {
		const count = typeCounts.get(type.key) ?? 0;
		const min = type.limits?.minInstances;
		const max = type.limits?.maxInstances;

		if (min !== undefined && count < min) {
			add(
				{ code: 'min_instances' },
				`The graph needs at least ${plural(min, `"${type.label}" node`)} (it has ${count}).`,
				`type:${type.key}`,
			);
		}

		if (max !== undefined && count > max) {
			const extra = extraOfType.get(type.key);
			const ref: IssueRef = { code: 'max_instances' };
			if (extra) ref.nodeId = extra.id;

			// Fingerprinted by type, not by node, so deleting one of the extra
			// nodes never looks like a new error to the ratchet policy.
			drafts.push({
				...draft(ref, `Only ${plural(max, `"${type.label}" node`)} ${max === 1 ? 'is' : 'are'} allowed (the graph has ${count}).`),
				fingerprint: issueFingerprint({ code: 'max_instances' }, `type:${type.key}`),
			});
		}
	}

	if (graphRules.maxNodes !== undefined && nodes.length > graphRules.maxNodes) {
		add({ code: 'max_nodes' }, `The graph has ${nodes.length} nodes; at most ${graphRules.maxNodes} are allowed.`);
	}

	if (graphRules.minNodes !== undefined && nodes.length < graphRules.minNodes) {
		add({ code: 'min_nodes' }, `The graph needs at least ${plural(graphRules.minNodes, 'node')} (it has ${nodes.length}).`);
	}

	if (graphRules.maxEdges !== undefined && edges.length > graphRules.maxEdges) {
		add({ code: 'max_edges' }, `The graph has ${edges.length} connections; at most ${graphRules.maxEdges} are allowed.`);
	}

	/* Connectivity ----------------------------------------------------------- */

	if (graphRules.requireConnected) {
		for (const node of index.nodeById.values()) {
			if (!degree.get(node.id)) add({ code: 'not_connected', nodeId: node.id }, `${name(node)} is not connected.`);
		}
	}

	if (!rules.allowCycles) {
		for (const edge of cycleEdges(index)) {
			const source = index.nodeById.get(edge.source);
			const target = index.nodeById.get(edge.target);
			add({ code: 'cycle', edgeId: edge.id }, `${name(source)} → ${name(target)}: this connection is part of a loop.`);
		}
	}

	if (graphRules.requireReachableFromEntry && graphRules.entryNodeTypes && graphRules.entryNodeTypes.length > 0) {
		const entryTypes = new Set(graphRules.entryNodeTypes);
		const entries = [...index.nodeById.values()].filter((node) => entryTypes.has(node.type));
		const labels = typeLabels(ruleset, graphRules.entryNodeTypes);

		if (entries.length === 0) {
			if (index.nodeById.size > 0) {
				add({ code: 'unreachable' }, `The graph has no ${labels} node to start from.`, 'no-entry');
			}
		} else {
			const reached = reachable(entries.map((node) => node.id), index.outgoing);

			for (const node of index.nodeById.values()) {
				if (!reached.has(node.id)) {
					add({ code: 'unreachable', nodeId: node.id }, `${name(node)} cannot be reached from ${labels}.`);
				}
			}
		}
	}

	return finish(ruleset, drafts);
}

/**
 * Normalises a raw field value and validates it in one step. Data that
 * normalisation had to drop becomes `invalid_document` issues (one per
 * problem), so a value written outside the editor with, for example, a
 * `__proto__` key or an edge without endpoints is rejected by the hook rather
 * than silently repaired. null, undefined and '' are an empty field: no
 * document, no issues. Pass `ruleset: null` when the field's ruleset does not
 * compile; only the structural checks run then.
 */
export function validateValue(ruleset: CompiledRuleset | null, raw: unknown): ValueReport {
	if (raw === null || raw === undefined || raw === '') return { document: null, issues: [], problems: [] };

	const { document, problems, fatal } = normalizeDocument(raw);
	const drafts: Draft[] = fatal.map((message) => draft({ code: 'invalid_document' }, message, message));
	const structural = ruleset ? finish(ruleset, drafts) : finishWithDefaults(drafts);

	const issues = ruleset ? [...structural, ...validateDocument(ruleset, document)] : structural;
	return { document, issues: sortIssues(issues), problems };
}

/** Errors first, then warnings; stable within each group. */
export function sortIssues(issues: Issue[]): Issue[] {
	return [...issues.filter((issue) => issue.severity === 'error'), ...issues.filter((issue) => issue.severity === 'warning')];
}

function finish(ruleset: CompiledRuleset, drafts: Draft[]): Issue[] {
	const issues: Issue[] = [];

	for (const item of drafts) {
		const severity = ruleset.severities[item.code];
		if (severity === 'off') continue;
		issues.push({ ...item, severity });
	}

	return sortIssues(issues);
}

function finishWithDefaults(drafts: Draft[]): Issue[] {
	return sortIssues(drafts.map((item) => ({ ...item, severity: DEFAULT_SEVERITIES[item.code] })));
}

/**
 * Required fields without a value, the way the Directus form judges them:
 * null, undefined, '' and [] are empty. Hidden fields cannot be filled in the
 * inspector and alias fields hold no data, so both are skipped.
 */
function missingRequired(fields: readonly NodeGraphField[] | undefined, data: unknown): NodeGraphField[] {
	if (!fields || fields.length === 0) return [];

	const values = isPlainObject(data) ? data : {};

	return fields.filter((field) => {
		if (!field.meta?.required || field.meta.hidden || field.type === 'alias') return false;

		const value = Object.prototype.hasOwnProperty.call(values, field.field) ? values[field.field] : undefined;
		return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
	});
}

/**
 * Edges that lie on a cycle: edges whose endpoints are in the same strongly
 * connected component of more than one node (self loops are a separate rule).
 * Iterative Tarjan, O(nodes + edges).
 */
function cycleEdges(index: GraphIndex): GraphEdge[] {
	const { nodeById, outgoing } = index;
	const order = new Map<string, number>();
	const low = new Map<string, number>();
	const component = new Map<string, number>();
	const componentSize: number[] = [];
	const onStack = new Set<string>();
	const stack: string[] = [];
	let counter = 0;

	const successors = (id: string) => (outgoing.get(id) ?? []).filter((edge) => edge.target !== id);

	for (const start of nodeById.keys()) {
		if (order.has(start)) continue;

		const frames: Array<{ id: string; next: number; edges: GraphEdge[] }> = [];

		const visit = (id: string) => {
			order.set(id, counter);
			low.set(id, counter);
			counter++;
			stack.push(id);
			onStack.add(id);
			frames.push({ id, next: 0, edges: successors(id) });
		};

		visit(start);

		while (frames.length > 0) {
			const frame = frames[frames.length - 1]!;

			if (frame.next < frame.edges.length) {
				const next = frame.edges[frame.next++]!.target;

				if (!order.has(next)) {
					visit(next);
				} else if (onStack.has(next)) {
					low.set(frame.id, Math.min(low.get(frame.id)!, order.get(next)!));
				}

				continue;
			}

			frames.pop();

			const parent = frames[frames.length - 1];
			if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));

			if (low.get(frame.id) === order.get(frame.id)) {
				const id = componentSize.length;
				let size = 0;
				let member: string;

				do {
					member = stack.pop()!;
					onStack.delete(member);
					component.set(member, id);
					size++;
				} while (member !== frame.id);

				componentSize.push(size);
			}
		}
	}

	// Document order, so issues come out in a stable order.
	return index.edges.filter((edge) => {
		if (edge.source === edge.target || !nodeById.has(edge.source) || !nodeById.has(edge.target)) return false;

		const id = component.get(edge.source);
		return id !== undefined && id === component.get(edge.target) && componentSize[id]! > 1;
	});
}

/**
 * The minimum shape validateDocument relies on: arrays of objects with string
 * ids, types and endpoints. Anything normalizeDocument produced passes.
 */
function hasDocumentShape(document: unknown): document is GraphDocument {
	if (!isPlainObject(document) || !Array.isArray(document['nodes']) || !Array.isArray(document['edges'])) return false;

	const nodesOk = document['nodes'].every(
		(node: unknown) => isPlainObject(node) && typeof node['id'] === 'string' && typeof node['type'] === 'string',
	);

	const edgesOk = document['edges'].every(
		(edge: unknown) =>
			isPlainObject(edge) &&
			typeof edge['id'] === 'string' &&
			typeof edge['source'] === 'string' &&
			typeof edge['target'] === 'string' &&
			typeof edge['sourceHandle'] === 'string' &&
			typeof edge['targetHandle'] === 'string' &&
			(edge['type'] === undefined || typeof edge['type'] === 'string'),
	);

	return nodesOk && edgesOk;
}

/** Nodes reachable from `starts` (inclusive) along edges, BFS. */
function reachable(starts: string[], outgoing: Map<string, GraphEdge[]>): Set<string> {
	const seen = new Set(starts);
	const queue = [...starts];

	for (let head = 0; head < queue.length; head++) {
		for (const edge of outgoing.get(queue[head]!) ?? []) {
			if (!seen.has(edge.target)) {
				seen.add(edge.target);
				queue.push(edge.target);
			}
		}
	}

	return seen;
}
