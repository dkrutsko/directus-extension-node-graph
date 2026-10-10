import { defineHook } from '@directus/extensions-sdk';
import { createGuard } from './shared/hook/guard';

/**
 * Server-side enforcement for fields that use the `node-graph` interface:
 * validates graph values on item create and update against the field's
 * ruleset (with the field's enforcement policy), recomputes the stored
 * `meta`, and rejects field options whose ruleset does not compile.
 * See ./shared/hook/guard.ts.
 */
export default defineHook(createGuard('node-graph'));
