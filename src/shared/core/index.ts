/**
 * Node-graph core: the framework-free rules engine shared by the editor, the
 * display and the API hook, so all three always judge a graph the same way.
 *
 * Everything exported here is pure and synchronous, runs unchanged in the
 * browser and in Node 22, and never throws on malformed input. It imports no
 * Vue, no DOM and no Node APIs (tsconfig.test.json type-checks it without the
 * DOM library to keep it that way).
 */

export type * from './types';

export {
	DEFAULT_SEVERITIES,
	IMPLICIT_EDGE_TYPE,
	ISSUE_CODES,
	RULESET_FORMAT,
	compileRuleset,
	isCompiledRuleset,
	type CompileResult,
} from './compile';

export {
	ANY_DATA_TYPE,
	NEUTRAL_PORT_COLOR,
	UNDECLARED_PORT_COLOR,
	dataTypeAccepts,
	defaultSide,
	getDocumentPorts,
	getPorts,
	portEdgeTypes,
	type NodePorts,
} from './ports';

export {
	DOCUMENT_FORMAT,
	DOCUMENT_VERSION,
	emptyDocument,
	fieldDefaults,
	normalizeDocument,
	starterDocument,
} from './document';

export { canConnect, type ConnectOptions } from './connect';
export { issueFingerprint, sortIssues, validateDocument, validateValue, type IssueRef, type ValidateOptions } from './validate';
export { applyCommand } from './commands';
export { computeMeta } from './meta';
export { canonicalJson, graphHash, sha256Hex } from './hash';
export { formatValue, renderTemplate, renderTemplateDetailed, templatePaths, type TemplateResult } from './template';
export { edgeLabel, nodeSummary, nodeTitle } from './labels';
export {
	REFERENCE_INTERFACES,
	asReference,
	collectReferences,
	documentReferences,
	isReferenceField,
	referenceText,
	type ReferenceOccurrence,
} from './references';
export { DEFAULT_FIELD_TEMPLATE, fieldSummary } from './summary';
export { generateId } from './ids';
export { exampleRuleset } from './example-ruleset';
