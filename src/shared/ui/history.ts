/**
 * Undo/redo for the editor, over whole documents.
 *
 * applyCommand() returns new documents with structural sharing (untouched
 * nodes and edges keep their identity), so keeping 100 snapshots costs
 * little more than the changed elements. Snapshots are never mutated.
 *
 * Rules:
 * - at most 100 steps back;
 * - a drag is one step: `moveNodes` with `final: false` are coalesced with
 *   the drop (`final: true`);
 * - the viewport is never recorded, and undo/redo keep the current viewport
 *   instead of jumping back to where the view was;
 * - typing into an inspector field is one step per field per pause (the
 *   Directus inputs emit on every keystroke).
 */

import { computed, shallowRef, type ComputedRef, type ShallowRef } from 'vue';
import type { GraphDocument } from '../core';

export const HISTORY_LIMIT = 100;

export interface HistoryStepOptions {
	/** Consecutive steps with the same key are merged into one. */
	coalesce?: string | null;
	/** Only merge when the previous step is at most this old (ms). Default: no limit. */
	within?: number;
}

export interface GraphHistory {
	/** The current document. Read-only: change it through push() or replace(). */
	readonly document: Readonly<ShallowRef<GraphDocument>>;
	readonly canUndo: ComputedRef<boolean>;
	readonly canRedo: ComputedRef<boolean>;
	/** Starts over with `document` and an empty history. */
	reset(document: GraphDocument): void;
	/** Records `next` as a step (or merges it into the previous one, see HistoryStepOptions). */
	push(next: GraphDocument, options?: HistoryStepOptions): void;
	/** Swaps the current document without recording a step (viewport changes). */
	replace(next: GraphDocument): void;
	/** Ends coalescing, so the next step is recorded on its own. */
	seal(): void;
	undo(): boolean;
	redo(): boolean;
}

export function useGraphHistory(initial: GraphDocument, limit = HISTORY_LIMIT): GraphHistory {
	const document = shallowRef<GraphDocument>(initial);

	// Plain arrays plus a version counter: the snapshots themselves need no
	// reactivity, only the "can undo / can redo" flags do.
	let past: GraphDocument[] = [];
	let future: GraphDocument[] = [];
	const version = shallowRef(0);

	let lastKey: string | null = null;
	let lastTime = 0;

	const canUndo = computed(() => version.value >= 0 && past.length > 0);
	const canRedo = computed(() => version.value >= 0 && future.length > 0);

	function touch() {
		version.value++;
	}

	function reset(next: GraphDocument) {
		past = [];
		future = [];
		lastKey = null;
		document.value = next;
		touch();
	}

	function push(next: GraphDocument, options: HistoryStepOptions = {}) {
		if (next === document.value) return;

		const now = Date.now();
		const key = options.coalesce ?? null;
		const within = options.within ?? Number.POSITIVE_INFINITY;
		const merge = key !== null && key === lastKey && past.length > 0 && now - lastTime <= within;

		if (!merge) {
			past.push(document.value);
			if (past.length > limit) past.splice(0, past.length - limit);
		}

		future = [];
		lastKey = key;
		lastTime = now;
		document.value = next;
		touch();
	}

	function replace(next: GraphDocument) {
		document.value = next;
	}

	function seal() {
		lastKey = null;
	}

	function undo(): boolean {
		const previous = past.pop();
		if (!previous) return false;

		future.push(document.value);
		lastKey = null;
		document.value = keepViewport(previous, document.value);
		touch();
		return true;
	}

	function redo(): boolean {
		const next = future.pop();
		if (!next) return false;

		past.push(document.value);
		lastKey = null;
		document.value = keepViewport(next, document.value);
		touch();
		return true;
	}

	return { document, canUndo, canRedo, reset, push, replace, seal, undo, redo };
}

/** `snapshot` with the viewport of `current`, so undo never moves the view. */
function keepViewport(snapshot: GraphDocument, current: GraphDocument): GraphDocument {
	const viewport = current.viewport;
	if (!viewport || snapshot.viewport === viewport) return snapshot;

	return { ...snapshot, viewport };
}
