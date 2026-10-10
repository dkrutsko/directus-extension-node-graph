/**
 * Node and edge fields in the inspector's `v-form`.
 *
 * The ruleset declares fields in (a subset of) the Directus field shape, so
 * the inspector can render them with the app's global `VForm` and no
 * collection, the way the stock Repeater renders its sub-fields
 * (directus-11.17.4/app/src/interfaces/list/list.vue:94-101, 304-313).
 */

import { canonicalJson, type NodeGraphField } from '../core';
import { formatTitle, hasOwn, isPlainObject } from '../core/util';

/** A field as `v-form` expects it (`Field` from @directus/types, loosely). */
export interface FormFieldDefinition {
	field: string;
	name: string;
	type: string;
	meta: Record<string, unknown>;
	schema: { default_value: unknown };
}

/**
 * Fills in what `v-form` needs: a display name (the Repeater title-cases the
 * key the same way, list.vue:94-101), a `meta` object with a width (fields
 * without `meta` skip interface resolution in getFormFields,
 * app/src/components/v-form/utils/get-form-fields.ts:24-27) and a schema
 * default. `$t:` names are translated by v-form itself (get-form-fields.ts:22).
 */
export function toFormFields(fields: readonly NodeGraphField[] | undefined): FormFieldDefinition[] {
	return (fields ?? []).map((field, index) => {
		const meta: Record<string, unknown> = isPlainObject(field.meta) ? { ...field.meta } : {};

		return {
			field: field.field,
			name: field.name || formatTitle(field.field),
			type: field.type,
			meta: {
				...meta,
				field: field.field,
				interface: typeof meta['interface'] === 'string' ? meta['interface'] : null,
				width: typeof meta['width'] === 'string' ? meta['width'] : 'full',
				sort: typeof meta['sort'] === 'number' ? meta['sort'] : index + 1,
			},
			schema: { default_value: field.schema?.default_value ?? null },
		};
	});
}

/**
 * Turns what `v-form` emitted into the shallow data patch for an
 * `updateNodeData` / `updateEdge` command.
 *
 * The inspector binds `model-value` to the element's current data and
 * `initial-values` to its data when the editor opened, so `v-form` marks the
 * fields with unapplied changes with its "edited" dot. A field that is set
 * back to its initial value is *removed* from the emitted object
 * (form-field.vue:119-133 `emitValue`/`unsetValue`, v-form.vue:355-363), as is a field
 * set to its default when it has no initial value; a missing key therefore
 * means "the initial value", or the default.
 *
 * Only keys of the declared fields are considered; other keys in the data
 * (from an older ruleset, say) are left alone. Returns null when nothing
 * changed.
 */
export function formPatch(
	emitted: unknown,
	current: Record<string, unknown>,
	initial: Record<string, unknown> | null,
	fields: readonly FormFieldDefinition[],
): Record<string, unknown> | null {
	const values = isPlainObject(emitted) ? emitted : {};
	const patch: Record<string, unknown> = {};
	let changed = false;

	for (const field of fields) {
		const key = field.field;
		let next: unknown;

		if (hasOwn(values, key)) {
			next = values[key];
		} else if (initial && hasOwn(initial, key)) {
			next = initial[key];
		} else {
			next = field.schema.default_value ?? null;
		}

		if (next === undefined) next = null;

		const previous = hasOwn(current, key) ? current[key] : null;

		if (canonicalJson(next) !== canonicalJson(previous)) {
			patch[key] = next;
			changed = true;
		}
	}

	return changed ? patch : null;
}
