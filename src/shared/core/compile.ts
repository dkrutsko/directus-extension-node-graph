/**
 * Ruleset compiler: checks a raw ruleset (object or JSON string, as stored in
 * the field options), fills defaults, and builds lookup maps.
 *
 * Compilation is strict on purpose: any problem yields `ruleset: null`. A
 * ruleset that compiles is internally consistent (every reference resolves,
 * every number is sane), so the validator, the editor and the hook can trust
 * it without re-checking. The hook's `fields.create|update` filter runs the
 * same compiler, so admins see problems when they save the field rather than
 * when an editor opens it.
 *
 * Unknown top-level and nested keys are kept (forward compatibility, for
 * example a later `migrations` list); forbidden keys are reported.
 */

import { canConnect } from './connect';
import { DOCUMENT_FORMAT, DOCUMENT_VERSION } from './document';
import { getPorts } from './ports';
import type {
	CompiledDataType,
	CompiledRuleset,
	Connection,
	DataTypeDef,
	EdgeTypeDef,
	GraphDocument,
	GraphNode,
	IssueCode,
	NodeGraphField,
	NodeTypeDef,
	PortDef,
	Ruleset,
	Severity,
} from './types';
import {
	RESERVED_NAMES,
	VERSIONING_KEYS,
	echo,
	formatTitle,
	isFiniteNumber,
	isNonEmptyString,
	isNonNegativeInteger,
	isPlainObject,
	isSafeColor,
	sanitizeJson,
} from './util';

export const RULESET_FORMAT = 'directus-node-graph-ruleset';

/** Every issue code, in the order of the IssueCode union. */
export const ISSUE_CODES: readonly IssueCode[] = [
	'invalid_document',
	'duplicate_id',
	'unknown_node_type',
	'unknown_edge_type',
	'unknown_port',
	'dangling_edge',
	'type_mismatch',
	'pair_not_allowed',
	'self_loop',
	'cycle',
	'multi_edge',
	'max_connections',
	'edge_type_not_allowed',
	'wrong_direction',
	'max_instances',
	'max_nodes',
	'max_edges',
	'field_required',
	'min_connections',
	'min_instances',
	'min_nodes',
	'not_connected',
	'unreachable',
	'deprecated_node_type',
];

/**
 * Built-in severities (docs/ruleset.md lists them). Completeness checks and
 * deprecation are warnings so a freshly seeded or half-built graph can be
 * saved under the default `ratchet` policy; everything else is an error.
 */
export const DEFAULT_SEVERITIES: Readonly<Record<IssueCode, 'error' | 'warning'>> = Object.freeze({
	invalid_document: 'error',
	duplicate_id: 'error',
	unknown_node_type: 'error',
	unknown_edge_type: 'error',
	unknown_port: 'error',
	dangling_edge: 'error',
	type_mismatch: 'error',
	pair_not_allowed: 'error',
	self_loop: 'error',
	cycle: 'error',
	multi_edge: 'error',
	max_connections: 'error',
	edge_type_not_allowed: 'error',
	wrong_direction: 'error',
	max_instances: 'error',
	max_nodes: 'error',
	max_edges: 'error',
	field_required: 'error',
	min_connections: 'warning',
	min_instances: 'warning',
	min_nodes: 'warning',
	not_connected: 'warning',
	unreachable: 'warning',
	deprecated_node_type: 'warning',
});

/** Edge type synthesised for rulesets that declare none. */
export const IMPLICIT_EDGE_TYPE: Readonly<EdgeTypeDef> = Object.freeze({ key: 'default', label: 'Connection' });

/** Type, edge type, data type and port keys. Dots are reserved for dynamic port keys (`branches.0`). */
const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const MAX_KEY_LENGTH = 64;

/** Material Symbols ligature names as `<v-icon>` takes them. */
const ICON_PATTERN = /^[a-z0-9_]+$/;

const MAX_NODE_TYPES = 500;
const MAX_PORTS = 100;
const MAX_FIELDS = 200;
const MAX_TEXT_LENGTH = 2000;

/** Directus field types a node or edge field may use (alias for presentation interfaces). */
const FIELD_TYPES = new Set([
	'string',
	'text',
	'integer',
	'bigInteger',
	'float',
	'decimal',
	'boolean',
	'json',
	'csv',
	'uuid',
	'hash',
	'date',
	'time',
	'dateTime',
	'timestamp',
	'alias',
]);

/**
 * Interfaces that need directus_relations rows or a collection-backed group
 * and therefore cannot work in a collection-less VForm
 * (directus-11.17.4/app/src/interfaces, `relational: true` / group-*).
 */
const UNSUPPORTED_INTERFACES = new Set([
	'file',
	'file-image',
	'files',
	'list-m2a',
	'list-m2m',
	'list-o2m',
	'list-o2m-tree-view',
	'select-dropdown-m2o',
	'translations',
	'group-accordion',
	'group-detail',
	'group-raw',
	'group-tabs',
]);

const FIELD_WIDTHS = new Set(['half', 'half-left', 'half-right', 'full', 'fill']);
const PORT_SIDES = new Set(['left', 'right', 'top', 'bottom']);
const EDGE_PATHS = new Set(['bezier', 'step', 'straight']);
const EDGE_MARKERS = new Set(['arrow', 'none']);
const SEVERITIES = new Set<Severity>(['error', 'warning', 'off']);

export interface CompileResult {
	ruleset: CompiledRuleset | null;
	problems: string[];
}

/**
 * Checks and compiles a ruleset. Accepts the parsed object or a JSON string
 * (the stock input-code interface stores a parsed object for a `json` option,
 * but values written through the API may be strings). Never throws.
 */
export function compileRuleset(raw: unknown): CompileResult {
	const problems: string[] = [];

	try {
		const ruleset = compile(raw, problems);
		if (!ruleset || problems.length > 0) return { ruleset: null, problems };
		return { ruleset, problems };
	} catch {
		problems.push('The ruleset could not be read.');
		return { ruleset: null, problems };
	}
}

function compile(raw: unknown, problems: string[]): CompiledRuleset | null {
	let parsed = raw;

	if (typeof parsed === 'string') {
		if (parsed.trim() === '') {
			problems.push('No ruleset is configured.');
			return null;
		}

		try {
			parsed = JSON.parse(parsed);
		} catch (error) {
			problems.push(`The ruleset is not valid JSON (${error instanceof Error ? error.message : 'parse error'}).`);
			return null;
		}
	}

	if (parsed === null || parsed === undefined) {
		problems.push('No ruleset is configured.');
		return null;
	}

	if (!isPlainObject(parsed)) {
		problems.push('The ruleset must be a JSON object.');
		return null;
	}

	// Deep copy first: everything below works on our own data, never on the
	// caller's (possibly reactive) object.
	const source = sanitizeJson(parsed, '', {
		stripVersioningKeys: false,
		report: (path, problem) => {
			if (problem === 'forbidden_key') problems.push(`${path}: the key is not allowed.`);
			else if (problem === 'too_deep') problems.push(`${path}: nested too deeply.`);
			else problems.push(`${path}: not a JSON value.`);
		},
	}) as Record<string, unknown>;

	const check = new Checker(problems);

	/* Header ------------------------------------------------------------- */

	if (source['format'] !== undefined && source['format'] !== RULESET_FORMAT) {
		check.fail('format', `must be "${RULESET_FORMAT}"`);
	}

	if (source['schemaVersion'] !== undefined && source['schemaVersion'] !== 1) {
		check.fail('schemaVersion', 'is not supported (expected 1)');
	}

	const key = source['key'];

	if (!isNonEmptyString(key) || key.length > 200) {
		check.fail('key', 'is required (a short identifier such as "approval-workflow")');
	}

	const version = source['version'] ?? 1;
	if (!isNonNegativeInteger(version)) check.fail('version', 'must be a whole number');

	const name = source['name'] ?? key;
	if (typeof name !== 'string') check.fail('name', 'must be text');

	const direction = source['direction'] ?? 'LR';
	if (direction !== 'LR' && direction !== 'TB') check.fail('direction', 'must be "LR" or "TB"');

	/* Data types --------------------------------------------------------- */

	const dataTypes = check.array<DataTypeDef>(source['dataTypes'], 'dataTypes', false);
	const dataTypeKeys = new Set<string>();

	dataTypes.forEach((dataType, index) => {
		const path = `dataTypes[${index}]`;
		if (!check.object(dataType, path)) return;

		if (check.key(dataType.key, `${path}.key`, dataTypeKeys)) {
			if (dataType.key === 'any') check.fail(`${path}.key`, '"any" is built in and cannot be redefined');
		}

		check.optionalText(dataType.label, `${path}.label`);
		check.optionalColor(dataType.color, `${path}.color`);
	});

	dataTypes.forEach((dataType, index) => {
		if (!isPlainObject(dataType) || dataType.accepts === undefined) return;

		const path = `dataTypes[${index}].accepts`;

		if (!Array.isArray(dataType.accepts)) {
			check.fail(path, 'must be a list of data type keys');
			return;
		}

		dataType.accepts.forEach((accepted, i) => {
			if (accepted !== 'any' && !(typeof accepted === 'string' && dataTypeKeys.has(accepted))) {
				check.fail(`${path}[${i}]`, `"${String(accepted)}" is not a defined data type`);
			}
		});
	});

	const knownDataType = (value: unknown) => value === 'any' || (typeof value === 'string' && dataTypeKeys.has(value));

	/* Edge types --------------------------------------------------------- */

	const declaredEdgeTypes = check.array<EdgeTypeDef>(source['edgeTypes'], 'edgeTypes', false);
	const edgeTypeKeys = new Set<string>();

	declaredEdgeTypes.forEach((edgeType, index) => {
		const path = `edgeTypes[${index}]`;
		if (!check.object(edgeType, path)) return;

		check.key(edgeType.key, `${path}.key`, edgeTypeKeys);
		edgeType.label = check.label(edgeType.label, edgeType.key, `${path}.label`);
		check.optionalText(edgeType.labelTemplate, `${path}.labelTemplate`);

		if (edgeType.style !== undefined) {
			if (check.object(edgeType.style, `${path}.style`)) {
				const style = edgeType.style;
				check.optionalEnum(style.path, EDGE_PATHS, `${path}.style.path`);
				check.optionalColor(style.color, `${path}.style.color`);
				check.optionalBoolean(style.dashed, `${path}.style.dashed`);
				check.optionalBoolean(style.animated, `${path}.style.animated`);
				check.optionalEnum(style.marker, EDGE_MARKERS, `${path}.style.marker`);
			}
		}

		check.fields(edgeType.fields, `${path}.fields`);
	});

	const edgeTypes: EdgeTypeDef[] = declaredEdgeTypes.length > 0 ? declaredEdgeTypes : [{ ...IMPLICIT_EDGE_TYPE }];
	if (declaredEdgeTypes.length === 0) edgeTypeKeys.add(IMPLICIT_EDGE_TYPE.key);

	/* Node types --------------------------------------------------------- */

	const nodeTypes = check.array<NodeTypeDef>(source['nodeTypes'], 'nodeTypes', true);
	const nodeTypeKeys = new Set<string>();

	if (nodeTypes.length === 0 && Array.isArray(source['nodeTypes'])) {
		check.fail('nodeTypes', 'must declare at least one node type');
	}

	if (nodeTypes.length > MAX_NODE_TYPES) check.fail('nodeTypes', `may declare at most ${MAX_NODE_TYPES} node types`);

	nodeTypes.forEach((nodeType, index) => {
		const path = `nodeTypes[${index}]`;
		if (!check.object(nodeType, path)) return;

		check.key(nodeType.key, `${path}.key`, nodeTypeKeys);
		nodeType.label = check.label(nodeType.label, nodeType.key, `${path}.label`);

		if (nodeType.icon !== undefined && !(typeof nodeType.icon === 'string' && ICON_PATTERN.test(nodeType.icon))) {
			check.fail(`${path}.icon`, 'must be a Material Symbols name such as "task_alt"');
		}

		check.optionalColor(nodeType.color, `${path}.color`);
		check.optionalText(nodeType.description, `${path}.description`);
		check.optionalText(nodeType.category, `${path}.category`);
		check.optionalBoolean(nodeType.deprecated, `${path}.deprecated`);
		check.optionalBoolean(nodeType.deletable, `${path}.deletable`);
		check.optionalText(nodeType.titleTemplate, `${path}.titleTemplate`);

		if (nodeType.limits !== undefined && check.object(nodeType.limits, `${path}.limits`)) {
			check.range(nodeType.limits.minInstances, nodeType.limits.maxInstances, `${path}.limits`, 'minInstances', 'maxInstances');
		}

		const fieldKeys = check.fields(nodeType.fields, `${path}.fields`);

		if (nodeType.summaryFields !== undefined) {
			if (!Array.isArray(nodeType.summaryFields)) {
				check.fail(`${path}.summaryFields`, 'must be a list of field keys');
			} else {
				nodeType.summaryFields.forEach((field, i) => {
					if (typeof field !== 'string' || !fieldKeys.has(field)) {
						check.fail(`${path}.summaryFields[${i}]`, `"${String(field)}" is not a field of this node type`);
					}
				});
			}
		}

		const portCheck = { knownDataType, edgeTypeKeys };
		check.ports(nodeType.inputs, `${path}.inputs`, 'input', portCheck);
		check.ports(nodeType.outputs, `${path}.outputs`, 'output', portCheck);

		if (nodeType.dynamicOutputs !== undefined) {
			const dynamicPath = `${path}.dynamicOutputs`;

			if (check.object(nodeType.dynamicOutputs, dynamicPath)) {
				const dynamic = nodeType.dynamicOutputs;
				const field = (nodeType.fields ?? []).find((candidate) => isPlainObject(candidate) && candidate.field === dynamic.field);

				if (!field) {
					check.fail(`${dynamicPath}.field`, `"${String(dynamic.field)}" is not a field of this node type`);
				} else if (field.type !== 'json') {
					check.fail(`${dynamicPath}.field`, `"${field.field}" must be a json field (a repeater)`);
				}

				check.optionalText(dynamic.labelTemplate, `${dynamicPath}.labelTemplate`);
				check.optionalEnum(dynamic.placement, new Set(['start', 'end']), `${dynamicPath}.placement`);

				if (dynamic.port !== undefined && check.object(dynamic.port, `${dynamicPath}.port`)) {
					check.port({ ...dynamic.port, key: 'dynamic' }, `${dynamicPath}.port`, 'output', portCheck);
				}
			}
		}
	});

	/* Connection and graph rules ----------------------------------------- */

	const connectionRules = isPlainObject(source['connectionRules']) ? source['connectionRules'] : {};

	if (source['connectionRules'] !== undefined && !isPlainObject(source['connectionRules'])) {
		check.fail('connectionRules', 'must be an object');
	}

	const declaredDefault = connectionRules['defaultEdgeType'];

	if (declaredDefault !== undefined && !(typeof declaredDefault === 'string' && edgeTypeKeys.has(declaredDefault))) {
		check.fail('connectionRules.defaultEdgeType', `"${String(declaredDefault)}" is not a defined edge type`);
	}

	const firstEdgeType = edgeTypes[0];

	const defaultEdgeType =
		typeof declaredDefault === 'string' && edgeTypeKeys.has(declaredDefault)
			? declaredDefault
			: isPlainObject(firstEdgeType) && typeof firstEdgeType.key === 'string'
				? firstEdgeType.key
				: IMPLICIT_EDGE_TYPE.key;

	check.optionalEnum(connectionRules['typeCheck'], new Set(['strict', 'off']), 'connectionRules.typeCheck');
	check.optionalBoolean(connectionRules['allowSelfLoops'], 'connectionRules.allowSelfLoops');
	check.optionalBoolean(connectionRules['allowCycles'], 'connectionRules.allowCycles');
	check.optionalBoolean(connectionRules['allowMultiEdges'], 'connectionRules.allowMultiEdges');

	const pairs = connectionRules['pairs'];

	if (pairs !== undefined && check.object(pairs, 'connectionRules.pairs')) {
		check.optionalEnum(pairs['mode'], new Set(['allow', 'deny']), 'connectionRules.pairs.mode');
		if (pairs['mode'] === undefined) check.fail('connectionRules.pairs.mode', 'is required ("allow" or "deny")');

		const rules = check.array<Record<string, unknown>>(pairs['rules'], 'connectionRules.pairs.rules', true);

		rules.forEach((rule, index) => {
			const path = `connectionRules.pairs.rules[${index}]`;
			if (!check.object(rule, path)) return;

			for (const member of ['source', 'target'] as const) {
				const value = rule[member];
				if (value === undefined || value === '*') continue;

				if (!(typeof value === 'string' && nodeTypeKeys.has(value))) {
					check.fail(`${path}.${member}`, `"${String(value)}" is not a defined node type`);
				}
			}

			for (const member of ['sourcePort', 'targetPort'] as const) {
				const value = rule[member];
				if (value !== undefined && typeof value !== 'string') check.fail(`${path}.${member}`, 'must be a port key');
			}

			check.optionalText(rule['message'], `${path}.message`);
		});
	}

	const graphRules = isPlainObject(source['graphRules']) ? source['graphRules'] : {};

	if (source['graphRules'] !== undefined && !isPlainObject(source['graphRules'])) {
		check.fail('graphRules', 'must be an object');
	}

	check.range(graphRules['minNodes'], graphRules['maxNodes'], 'graphRules', 'minNodes', 'maxNodes');
	if (graphRules['maxEdges'] !== undefined && !isNonNegativeInteger(graphRules['maxEdges'])) {
		check.fail('graphRules.maxEdges', 'must be a whole number of 0 or more');
	}

	check.optionalBoolean(graphRules['requireReachableFromEntry'], 'graphRules.requireReachableFromEntry');
	check.optionalBoolean(graphRules['requireConnected'], 'graphRules.requireConnected');

	const entryNodeTypes = graphRules['entryNodeTypes'];

	if (entryNodeTypes !== undefined) {
		if (!Array.isArray(entryNodeTypes)) {
			check.fail('graphRules.entryNodeTypes', 'must be a list of node type keys');
		} else {
			entryNodeTypes.forEach((value, index) => {
				if (!(typeof value === 'string' && nodeTypeKeys.has(value))) {
					check.fail(`graphRules.entryNodeTypes[${index}]`, `"${String(value)}" is not a defined node type`);
				}
			});
		}
	}

	if (graphRules['requireReachableFromEntry'] === true && !(Array.isArray(entryNodeTypes) && entryNodeTypes.length > 0)) {
		check.fail('graphRules.requireReachableFromEntry', 'needs at least one entry node type in entryNodeTypes');
	}

	/* Severity overrides -------------------------------------------------- */

	const severities: Record<IssueCode, Severity> = { ...DEFAULT_SEVERITIES };
	const issueCodes = new Set<string>(ISSUE_CODES);

	if (source['severity'] !== undefined && check.object(source['severity'], 'severity')) {
		const overrides = source['severity'];

		for (const code of Object.keys(overrides)) {
			const value = overrides[code];

			if (!issueCodes.has(code)) {
				check.fail(`severity.${code}`, 'is not a known issue code');
			} else if (!SEVERITIES.has(value as Severity)) {
				check.fail(`severity.${code}`, 'must be "error", "warning" or "off"');
			} else {
				severities[code as IssueCode] = value as Severity;
			}
		}
	}

	checkStarterNodes(source['starter'], nodeTypeKeys, check);

	if (problems.length > 0) return null;

	/* Build --------------------------------------------------------------- */

	const dataTypeMap = new Map<string, CompiledDataType>();

	for (const dataType of dataTypes) {
		dataTypeMap.set(dataType.key, {
			...dataType,
			label: dataType.label || formatTitle(dataType.key),
			color: dataType.color || 'var(--theme--foreground-subdued)',
			acceptSet: new Set(dataType.accepts ?? []),
		});
	}

	const compiled = {
		...source,
		format: RULESET_FORMAT,
		schemaVersion: 1,
		key: key as string,
		version: version as number,
		name: name as string,
		direction: direction as 'LR' | 'TB',
		dataTypes,
		nodeTypes,
		edgeTypes,
		connectionRules: {
			...connectionRules,
			defaultEdgeType,
			typeCheck: connectionRules['typeCheck'] === 'off' ? 'off' : 'strict',
			allowSelfLoops: connectionRules['allowSelfLoops'] === true,
			allowCycles: connectionRules['allowCycles'] !== false,
			allowMultiEdges: connectionRules['allowMultiEdges'] === true,
		},
		graphRules,
		nodeTypeMap: new Map(nodeTypes.map((nodeType) => [nodeType.key, nodeType])),
		edgeTypeMap: new Map(edgeTypes.map((edgeType) => [edgeType.key, edgeType])),
		dataTypeMap,
		defaultEdgeType,
		severities,
	} as CompiledRuleset;

	checkPairPorts(compiled, check);
	checkStarterEdges(compiled, check);

	// Only meaningful once every starter reference resolves.
	if (problems.length === 0) checkStarterGraph(compiled, check);

	return problems.length > 0 ? null : compiled;
}

/**
 * Pair rules that name a specific node type and port must name a real port.
 * `field.*` matches every output generated from a repeater field.
 */
function checkPairPorts(ruleset: CompiledRuleset, check: Checker): void {
	const rules = ruleset.connectionRules.pairs?.rules ?? [];

	rules.forEach((rule, index) => {
		const path = `connectionRules.pairs.rules[${index}]`;

		const checkPort = (typeKey: string | undefined, port: string | undefined, direction: 'inputs' | 'outputs', member: string) => {
			if (!typeKey || typeKey === '*' || port === undefined || port === '*') return;

			const nodeType = ruleset.nodeTypeMap.get(typeKey);
			if (!nodeType) return;

			const declared = (nodeType[direction] ?? []).some((def) => def.key === port);
			const dynamic = direction === 'outputs' && nodeType.dynamicOutputs && port === `${nodeType.dynamicOutputs.field}.*`;

			if (!declared && !dynamic) {
				check.fail(`${path}.${member}`, `"${port}" is not ${direction === 'inputs' ? 'an input' : 'an output'} of "${typeKey}"`);
			}
		};

		checkPort(rule.source, rule.sourcePort, 'outputs', 'sourcePort');
		checkPort(rule.target, rule.targetPort, 'inputs', 'targetPort');
	});
}

/** Starter nodes: unique refs, known types, numeric positions. Needs only the node type keys. */
function checkStarterNodes(starter: unknown, nodeTypeKeys: Set<string>, check: Checker): void {
	if (starter === undefined) return;
	if (!check.object(starter, 'starter')) return;

	const nodes = check.array<Record<string, unknown>>(starter['nodes'], 'starter.nodes', true);
	const refs = new Set<string>();

	nodes.forEach((node, index) => {
		const path = `starter.nodes[${index}]`;
		if (!check.object(node, path)) return;

		const ref = node['ref'];

		if (!isNonEmptyString(ref)) {
			check.fail(`${path}.ref`, 'is required');
		} else if (refs.has(ref)) {
			check.fail(`${path}.ref`, `"${ref}" is used twice`);
		} else {
			refs.add(ref);
		}

		if (!(typeof node['type'] === 'string' && nodeTypeKeys.has(node['type']))) {
			check.fail(`${path}.type`, `"${String(node['type'])}" is not a defined node type`);
		}

		const position = node['position'];

		if (!(isPlainObject(position) && isFiniteNumber(position['x']) && isFiniteNumber(position['y']))) {
			check.fail(`${path}.position`, 'must be { "x": number, "y": number }');
		}

		if (node['data'] !== undefined && !isPlainObject(node['data'])) check.fail(`${path}.data`, 'must be an object');
	});

	if (starter['edges'] !== undefined) check.array(starter['edges'], 'starter.edges', true);
}

/**
 * Starter edges: endpoints are starter refs, handles are real ports (dynamic
 * outputs resolved from the starter node's data), and the edge type is
 * allowed on the output. Runs on the compiled ruleset, after
 * checkStarterNodes passed.
 */
function checkStarterEdges(ruleset: CompiledRuleset, check: Checker): void {
	const starter = ruleset.starter;
	if (!starter || !Array.isArray(starter.edges)) return;

	const refs = new Map<string, GraphNode>();

	for (const node of starter.nodes) {
		refs.set(node.ref, { id: node.ref, type: node.type, position: { x: 0, y: 0 }, data: node.data ?? {} });
	}

	starter.edges.forEach((edge, index) => {
		const path = `starter.edges[${index}]`;
		if (!check.object(edge, path)) return;

		const source = refs.get(String(edge.source));
		const target = refs.get(String(edge.target));

		if (!source) check.fail(`${path}.source`, `"${String(edge.source)}" is not a starter node ref`);
		if (!target) check.fail(`${path}.target`, `"${String(edge.target)}" is not a starter node ref`);

		if (source) {
			const output = getPorts(ruleset, source).outputs.find((port) => port.key === edge.sourceHandle);

			if (!output) {
				check.fail(`${path}.sourceHandle`, `"${String(edge.sourceHandle)}" is not an output of "${source.type}"`);
			} else if (edge.type !== undefined && !output.edgeTypes.includes(String(edge.type))) {
				check.fail(`${path}.type`, `"${String(edge.type)}" is not allowed on output "${output.key}"`);
			}
		}

		if (target && !getPorts(ruleset, target).inputs.some((port) => port.key === edge.targetHandle)) {
			check.fail(`${path}.targetHandle`, `"${String(edge.targetHandle)}" is not an input of "${target.type}"`);
		}

		if (edge.data !== undefined && !isPlainObject(edge.data)) check.fail(`${path}.data`, 'must be an object');
	});
}

/**
 * The starter graph must be one a user can save. "Create" seeds it and the
 * hook's default `ratchet` policy rejects any error on a new item, so a
 * starter with two Start nodes or a Start → End edge (denied by a pair rule)
 * would make every new graph unsaveable until the user found and removed the
 * seeded fault. Checked here: no node type over `limits.maxInstances`, and
 * every starter edge accepted by canConnect, in order, against the edges
 * before it (so two edges on a single-connection output are caught too).
 * Completeness warnings (an unconnected End) and empty required fields are
 * fine: those are for the user to finish. Runs on the compiled ruleset, after
 * checkStarterEdges found every ref and handle.
 */
function checkStarterGraph(ruleset: CompiledRuleset, check: Checker): void {
	const starter = ruleset.starter;
	if (!starter || !Array.isArray(starter.nodes)) return;

	const counts = new Map<string, number>();
	for (const node of starter.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);

	for (const [typeKey, count] of counts) {
		const max = ruleset.nodeTypeMap.get(typeKey)?.limits?.maxInstances;

		if (max !== undefined && count > max && ruleset.severities.max_instances === 'error') {
			check.fail('starter.nodes', `has ${count} "${typeKey}" nodes, but at most ${max} ${max === 1 ? 'is' : 'are'} allowed`);
		}
	}

	if (!Array.isArray(starter.edges)) return;

	// Refs stand in for ids: they are unique, and canConnect only compares them.
	let document: GraphDocument = {
		format: DOCUMENT_FORMAT,
		version: DOCUMENT_VERSION,
		nodes: starter.nodes.map((node) => ({ id: node.ref, type: node.type, position: { x: 0, y: 0 }, data: node.data ?? {} })),
		edges: [],
	};

	starter.edges.forEach((edge, index) => {
		const connection: Connection = {
			source: edge.source,
			sourceHandle: edge.sourceHandle,
			target: edge.target,
			targetHandle: edge.targetHandle,
		};

		if (edge.type !== undefined) connection.type = edge.type;

		const result = canConnect(ruleset, document, connection);

		if (!result.ok) {
			check.fail(`starter.edges[${index}]`, result.message.replace(/\.$/, ''));
			return;
		}

		document = { ...document, edges: [...document.edges, { id: `starter.edges[${index}]`, type: result.type, ...connection }] };
	});
}

/**
 * Collects problems as `path: message.` lines. Each check reports and returns
 * whether the value passed, so the compiler can skip dependent checks.
 */
class Checker {
	constructor(private readonly problems: string[]) {}

	fail(path: string, message: string): false {
		this.problems.push(`${path}: ${message}.`);
		return false;
	}

	object(value: unknown, path: string): value is Record<string, any> {
		return isPlainObject(value) ? true : this.fail(path, 'must be an object');
	}

	array<T>(value: unknown, path: string, required: boolean): T[] {
		if (value === undefined && !required) return [];
		if (Array.isArray(value)) return value as T[];
		this.fail(path, 'must be a list');
		return [];
	}

	/** A unique, well-formed key; adds it to `seen`. */
	key(value: unknown, path: string, seen: Set<string>): value is string {
		if (typeof value !== 'string' || value === '') return this.fail(path, 'is required');

		if (value.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(value)) {
			return this.fail(path, `"${echo(value)}" must be at most ${MAX_KEY_LENGTH} letters, digits, "_" or "-"`);
		}

		// Canvases key plain objects by type and port keys (see RESERVED_NAMES).
		if (RESERVED_NAMES.has(value)) return this.fail(path, `"${value}" is a reserved name`);

		if (seen.has(value)) return this.fail(path, `"${value}" is used twice`);

		seen.add(value);
		return true;
	}

	/** A label, defaulting to the formatted key. */
	label(value: unknown, key: unknown, path: string): string {
		if (value === undefined || value === '') return typeof key === 'string' ? formatTitle(key) : '';
		if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) this.fail(path, 'must be text');
		return typeof value === 'string' ? value : '';
	}

	optionalText(value: unknown, path: string): void {
		if (value === undefined) return;
		if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) this.fail(path, 'must be text');
	}

	optionalBoolean(value: unknown, path: string): void {
		if (value !== undefined && typeof value !== 'boolean') this.fail(path, 'must be true or false');
	}

	optionalEnum(value: unknown, allowed: Set<string>, path: string): void {
		if (value === undefined) return;

		if (typeof value !== 'string' || !allowed.has(value)) {
			this.fail(path, `must be one of ${[...allowed].map((item) => `"${item}"`).join(', ')}`);
		}
	}

	optionalColor(value: unknown, path: string): void {
		if (value !== undefined && !isSafeColor(value)) {
			this.fail(path, 'must be a CSS colour such as "var(--theme--primary)" or "#6644ff"');
		}
	}

	/** Optional `min`/`max` whole numbers with min <= max. */
	range(min: unknown, max: unknown, path: string, minName: string, maxName: string): void {
		const minOk = min === undefined || isNonNegativeInteger(min);
		const maxOk = max === undefined || isNonNegativeInteger(max);

		if (!minOk) this.fail(`${path}.${minName}`, 'must be a whole number of 0 or more');
		if (!maxOk) this.fail(`${path}.${maxName}`, 'must be a whole number of 0 or more');

		if (minOk && maxOk && typeof min === 'number' && typeof max === 'number' && min > max) {
			this.fail(path, `${minName} (${min}) is larger than ${maxName} (${max})`);
		}
	}

	/** Node or edge fields; returns the field keys. */
	fields(value: unknown, path: string): Set<string> {
		const keys = new Set<string>();
		const fields = this.array<NodeGraphField>(value, path, false);

		if (fields.length > MAX_FIELDS) this.fail(path, `may declare at most ${MAX_FIELDS} fields`);

		fields.forEach((field, index) => {
			const fieldPath = `${path}[${index}]`;
			if (!this.object(field, fieldPath)) return;

			if (typeof field.field !== 'string' || field.field === '') {
				this.fail(`${fieldPath}.field`, 'is required');
			} else if (
				field.field.length > MAX_KEY_LENGTH ||
				!KEY_PATTERN.test(field.field) ||
				RESERVED_NAMES.has(field.field) ||
				VERSIONING_KEYS.has(field.field)
			) {
				this.fail(`${fieldPath}.field`, `"${echo(field.field)}" is not an allowed field key`);
			} else if (keys.has(field.field)) {
				this.fail(`${fieldPath}.field`, `"${field.field}" is used twice`);
			} else {
				keys.add(field.field);
			}

			if (typeof field.type !== 'string' || !FIELD_TYPES.has(field.type)) {
				this.fail(`${fieldPath}.type`, `"${String(field.type)}" is not a supported field type`);
			}

			this.optionalText(field.name, `${fieldPath}.name`);

			if (field.meta !== undefined && field.meta !== null) {
				if (!this.object(field.meta, `${fieldPath}.meta`)) return;

				const meta = field.meta;

				if (meta.interface !== undefined && meta.interface !== null) {
					if (typeof meta.interface !== 'string') {
						this.fail(`${fieldPath}.meta.interface`, 'must be an interface id');
					} else if (UNSUPPORTED_INTERFACES.has(meta.interface)) {
						this.fail(`${fieldPath}.meta.interface`, `"${meta.interface}" needs a relation or a collection and cannot be used inside a node`);
					}
				}

				if (meta.options !== undefined && meta.options !== null && !isPlainObject(meta.options)) {
					this.fail(`${fieldPath}.meta.options`, 'must be an object');
				}

				this.optionalEnum(meta.width, FIELD_WIDTHS, `${fieldPath}.meta.width`);
				this.optionalBoolean(meta.required, `${fieldPath}.meta.required`);
				this.optionalBoolean(meta.readonly, `${fieldPath}.meta.readonly`);
				this.optionalBoolean(meta.hidden, `${fieldPath}.meta.hidden`);
			}

			if (field.schema !== undefined && field.schema !== null) this.object(field.schema, `${fieldPath}.schema`);
		});

		return keys;
	}

	/** Inputs or outputs of one node type; returns the port keys. */
	ports(
		value: unknown,
		path: string,
		direction: 'input' | 'output',
		context: { knownDataType: (value: unknown) => boolean; edgeTypeKeys: Set<string> },
	): Set<string> {
		const keys = new Set<string>();
		const ports = this.array<PortDef>(value, path, false);

		if (ports.length > MAX_PORTS) this.fail(path, `may declare at most ${MAX_PORTS} ports`);

		ports.forEach((port, index) => {
			const portPath = `${path}[${index}]`;
			if (!this.object(port, portPath)) return;

			this.key(port.key, `${portPath}.key`, keys);
			this.port(port, portPath, direction, context);
		});

		return keys;
	}

	/** One port's settings (everything but the key's uniqueness). */
	port(
		def: object,
		path: string,
		direction: 'input' | 'output',
		context: { knownDataType: (value: unknown) => boolean; edgeTypeKeys: Set<string> },
	): void {
		const port = def as Record<string, unknown>;

		this.optionalText(port['label'], `${path}.label`);

		if (port['dataType'] !== undefined && !context.knownDataType(port['dataType'])) {
			this.fail(`${path}.dataType`, `"${String(port['dataType'])}" is not a defined data type`);
		}

		this.optionalEnum(port['side'], PORT_SIDES, `${path}.side`);

		const min = port['minConnections'];
		const max = port['maxConnections'];

		if (min !== undefined && !isNonNegativeInteger(min)) this.fail(`${path}.minConnections`, 'must be a whole number of 0 or more');

		if (max !== undefined && !(isNonNegativeInteger(max) && max >= 1)) {
			this.fail(`${path}.maxConnections`, 'must be a whole number of 1 or more');
		} else if (typeof min === 'number' && typeof max === 'number' && min > max) {
			this.fail(path, `minConnections (${min}) is larger than maxConnections (${max})`);
		}

		const edgeTypes = port['edgeTypes'];
		if (edgeTypes === undefined) return;

		if (direction === 'input') {
			this.fail(`${path}.edgeTypes`, 'only applies to outputs');
		} else if (!Array.isArray(edgeTypes) || edgeTypes.length === 0) {
			this.fail(`${path}.edgeTypes`, 'must be a non-empty list of edge type keys');
		} else {
			edgeTypes.forEach((edgeType, index) => {
				if (!(typeof edgeType === 'string' && context.edgeTypeKeys.has(edgeType))) {
					this.fail(`${path}.edgeTypes[${index}]`, `"${String(edgeType)}" is not a defined edge type`);
				}
			});
		}
	}
}

/** Type guard used by callers that hold either form. */
export function isCompiledRuleset(value: Ruleset | CompiledRuleset | null | undefined): value is CompiledRuleset {
	return !!value && (value as CompiledRuleset).nodeTypeMap instanceof Map;
}
