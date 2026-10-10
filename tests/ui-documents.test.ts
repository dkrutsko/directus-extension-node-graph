/**
 * The framework-free helpers of the editor shell (src/shared/ui/documents.ts).
 * The Vue components are checked by vue-tsc and in the browser; these
 * helpers decide whether Apply emits a value at all, so they are pinned here.
 */

import { describe, expect, test } from 'vitest';
import { hasGraphChanges, prepareForApply, sameViewport } from '../src/shared/ui/documents';
import { doc, edge, example, node, validWorkflow } from './helpers';

describe('sameViewport', () => {
	const base = doc([node('s', 'start')]);
	const at = (x: number, y: number, zoom: number) => ({ ...base, viewport: { x, y, zoom } });

	test('a baseline without a viewport matches any viewport (the fit on open is not an edit)', () => {
		expect(sameViewport(at(10, 20, 0.8), base)).toBe(true);
		expect(sameViewport(base, base)).toBe(true);
	});

	test('a baseline with a viewport only matches the same viewport', () => {
		expect(sameViewport(at(10, 20, 0.8), at(10, 20, 0.8))).toBe(true);
		expect(sameViewport(at(10, 20, 1), at(10, 20, 0.8))).toBe(false);
		expect(sameViewport(at(11, 20, 0.8), at(10, 20, 0.8))).toBe(false);
		expect(sameViewport(base, at(10, 20, 0.8))).toBe(false);
	});
});

describe('hasGraphChanges', () => {
	test('ignores the viewport, the stamp and meta', () => {
		const original = validWorkflow();
		const { document: applied } = prepareForApply(example, original);
		const panned = { ...applied, viewport: { x: 5, y: 5, zoom: 2 } };

		expect(hasGraphChanges(panned, original)).toBe(false);
	});

	test('sees a moved node and a new edge', () => {
		const original = doc([node('s', 'start'), node('e', 'end')]);
		const moved = { ...original, nodes: [{ ...original.nodes[0]!, position: { x: 36, y: 0 } }, original.nodes[1]!] };
		const connected = { ...original, edges: [edge('x', 's.next', 'e.in')] };

		expect(hasGraphChanges(moved, original)).toBe(true);
		expect(hasGraphChanges(connected, original)).toBe(true);
	});
});
