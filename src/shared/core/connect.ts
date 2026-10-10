/**
 * Connection check, used live while the user draws a connection (to dim
 * invalid targets and explain why) and again by applyCommand before an
 * `addEdge` or `reconnectEdge` is accepted.
 */

import { connectionKey, indexDocument, pairViolation, portKey, reaches } from './graph-index';
import { nodeName, plural, portName } from './messages';
import { dataTypeAccepts } from './ports';
import type { CompiledRuleset, ConnectResult, Connection, GraphDocument, IssueCode } from './types';
import { echo } from './util';

export interface ConnectOptions {
	/**
	 * Id of an existing edge to leave out of every count and of the cycle
	 * search, used when an edge is being reconnected so it does not block
	 * itself.
	 */
	ignoreEdgeId?: string;
}

/**
 * Whether `connection` may be added to `document`. On success returns the
 * edge type the new edge gets (`connection.type`, else the source port's
 * first allowed type). Checks run in a fixed order so the message names the
 * most basic problem first. O(nodes + edges) at worst (the cycle search); the
 * index behind it is cached per document object.
 *
 * canConnect refuses exactly the connections validateDocument would report
 * as an error on the new edge, so nothing drawn live is rejected on save and
 * nothing the server accepts is refused live:
 *
 * - Structural problems (a missing node, an unknown node type, port or edge
 *   type, a reversed connection) are always refused: such an edge cannot be
 *   drawn or typed.
 * - Rule checks (self loop, edge type allowed on the port, data types, pair
 *   rules, multi-edges, connection limits, cycles) refuse only while the
 *   ruleset's resolved severity for that code is 'error'. An admin who turns
 *   a rule down to 'warning' or 'off' (`ruleset.severity`) lets users draw
 *   the connection; validateDocument then reports it as a warning or not at
 *   all.
 */
export function canConnect(
	ruleset: CompiledRuleset,
	document: GraphDocument,
	connection: Connection,
	options: ConnectOptions = {},
): ConnectResult {
	const index = indexDocument(ruleset, document);
	const rules = ruleset.connectionRules;
	const enforced = (code: IssueCode) => ruleset.severities[code] === 'error';

	const source = index.nodeById.get(connection.source);
	const target = index.nodeById.get(connection.target);

	if (!source || !target) return fail('dangling_edge', 'One of the nodes no longer exists.');

	const sourceType = ruleset.nodeTypeMap.get(source.type);
	const targetType = ruleset.nodeTypeMap.get(target.type);

	if (!sourceType) return fail('unknown_node_type', `${nodeName(ruleset, source)} has an unknown node type and cannot be connected.`);
	if (!targetType) return fail('unknown_node_type', `${nodeName(ruleset, target)} has an unknown node type and cannot be connected.`);

	const sourcePorts = index.portsById.get(source.id)!;
	const targetPorts = index.portsById.get(target.id)!;

	const output = sourcePorts.outputs.get(connection.sourceHandle);
	const input = targetPorts.inputs.get(connection.targetHandle);

	if (!output || !input) {
		// Same test as validateDocument: a missing end that names a port of the other direction.
		const reversed =
			(!output && sourcePorts.inputs.has(connection.sourceHandle)) || (!input && targetPorts.outputs.has(connection.targetHandle));

		if (reversed) return fail('wrong_direction', 'Connections run from an output to an input.');

		return !output
			? fail('unknown_port', `${nodeName(ruleset, source)} has no output "${echo(connection.sourceHandle)}".`)
			: fail('unknown_port', `${nodeName(ruleset, target)} has no input "${echo(connection.targetHandle)}".`);
	}

	if (source.id === target.id && !rules.allowSelfLoops && enforced('self_loop')) {
		return fail('self_loop', 'A node cannot connect to itself.');
	}

	const type = connection.type ?? output.edgeTypes[0] ?? ruleset.defaultEdgeType;
	const edgeType = ruleset.edgeTypeMap.get(type);

	if (!edgeType) return fail('unknown_edge_type', `"${echo(type)}" is not a connection type of this ruleset.`);

	if (!output.edgeTypes.includes(type) && enforced('edge_type_not_allowed')) {
		return fail('edge_type_not_allowed', `${portName(output)} does not allow "${edgeType.label}" connections.`);
	}

	if (rules.typeCheck === 'strict' && !dataTypeAccepts(ruleset, input.dataType, output.dataType) && enforced('type_mismatch')) {
		return fail(
			'type_mismatch',
			`${portName(output)} (${output.dataTypeLabel}) cannot connect to ${portName(input)} (${input.dataTypeLabel}).`,
		);
	}

	const violation = enforced('pair_not_allowed') ? pairViolation(ruleset, sourceType.key, output.key, targetType.key, input.key) : null;

	if (violation) {
		return fail('pair_not_allowed', violation.message || `${sourceType.label} cannot connect to ${targetType.label}.`);
	}

	const ignored = options.ignoreEdgeId ? index.edges.find((edge) => edge?.id === options.ignoreEdgeId) : undefined;

	// How many existing edges use a key, not counting the edge being reconnected.
	const used = (map: Map<string, number>, key: string, ignoredKey: string | null) =>
		(map.get(key) ?? 0) - (ignoredKey === key ? 1 : 0);

	if (!rules.allowMultiEdges && enforced('multi_edge')) {
		const key = connectionKey(source.id, output.key, target.id, input.key);
		const ignoredKey = ignored ? connectionKey(ignored.source, ignored.sourceHandle, ignored.target, ignored.targetHandle) : null;

		if (used(index.connectionUse, key, ignoredKey) > 0) {
			return fail('multi_edge', 'These ports are already connected.');
		}
	}

	if (enforced('max_connections')) {
		if (output.maxConnections !== null) {
			const count = used(index.outputUse, portKey(source.id, output.key), ignored ? portKey(ignored.source, ignored.sourceHandle) : null);

			if (count >= output.maxConnections) {
				return fail('max_connections', `${portName(output)} already has ${plural(count, 'connection')} (at most ${output.maxConnections}).`);
			}
		}

		if (input.maxConnections !== null) {
			const count = used(index.inputUse, portKey(target.id, input.key), ignored ? portKey(ignored.target, ignored.targetHandle) : null);

			if (count >= input.maxConnections) {
				return fail('max_connections', `${portName(input)} already has ${plural(count, 'connection')} (at most ${input.maxConnections}).`);
			}
		}
	}

	// A new edge source → target closes a loop exactly when target already reaches source.
	if (
		!rules.allowCycles &&
		enforced('cycle') &&
		source.id !== target.id &&
		reaches(index, target.id, source.id, options.ignoreEdgeId)
	) {
		return fail('cycle', 'This connection would create a loop.');
	}

	return { ok: true, type };
}

function fail(code: IssueCode, message: string): ConnectResult {
	return { ok: false, code, message };
}
