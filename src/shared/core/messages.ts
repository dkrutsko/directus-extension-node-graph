/**
 * Wording helpers for issue and connection messages. Messages name node
 * titles (or ids), type labels and port labels, never other data: the hook
 * returns them to API callers before permission checks run
 * (directus-11.17.4/api/src/services/items.ts:726-746).
 */

import { nodeTitle } from './labels';
import type { CompiledRuleset, GraphNode, ResolvedPort } from './types';
import { truncate } from './util';

const MAX_NAME_LENGTH = 60;

/** `"Review access"`: a node's title in quotes. */
export function nodeName(ruleset: CompiledRuleset | null, node: GraphNode | undefined): string {
	if (!node) return 'a missing node';
	return `"${truncate(nodeTitle(ruleset, node), MAX_NAME_LENGTH)}"`;
}

/** `output "Next"` / `input "In"`. */
export function portName(port: Pick<ResolvedPort, 'label' | 'direction'>): string {
	return `${port.direction} "${truncate(port.label, MAX_NAME_LENGTH)}"`;
}

/** `1 connection`, `2 connections`. */
export function plural(count: number, word: string): string {
	return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** `"Start"` or `"Start" or "Trigger"`, from type keys. */
export function typeLabels(ruleset: CompiledRuleset, keys: readonly string[]): string {
	return keys.map((key) => `"${ruleset.nodeTypeMap.get(key)?.label ?? key}"`).join(' or ');
}
