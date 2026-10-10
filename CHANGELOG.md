# Changelog

## Unreleased

- **Ruleset editor in the field settings.** The Ruleset interface option is no longer one raw-JSON code editor but a form of stock Directus inputs, in the style of the stock Repeater's "Edit Fields": collapsible sections for the ruleset header, data types, node types, edge types, connection rules (with pair rules), graph rules, severity overrides and the starter graph; Repeaters with item drawers for every list; a node type's fields configured with the stock interface and display pickers and their options; selects whose choices come from the ruleset itself, with "(not defined)" entries for dangling references; and admin-facing notes with the template tokens. The interface's `options` is now a custom options component (`src/shared/options-editor`); the plain options (summary template, placeholder, editor width, enforcement, grid, minimap) render as before.
- **Live validation.** A notice above the sections says whether the ruleset is valid or lists the problems the server refuses the field save with, and one more lists entries that cannot be stored as entered (a severity override without a code, a default value that does not fit its field type).
- **Load Example** ("Approval workflow", "Simple approval", "Blank"), asking before it replaces a ruleset, and **Edit as JSON**: the whole ruleset in the code editor in a drawer, with the problems checked as you type, Copy, Download and Apply.
- **Same stored format, no migration.** `options.ruleset` is still one Ruleset object in the documented format, and every other option keeps its key and meaning. The form works on a view model and writes back only what changes: the stored rulesets round-trip exactly (key order included), unknown keys, `meta.conditions` and other keys the form does not show are kept, and documented defaults are never written into rulesets that left them out. A ruleset stored as JSON text opens in the form; one the form cannot show without changing it, or text that is not JSON, opens in the JSON editor with the reasons. Opening the field settings writes nothing.
- Field default values are entered as text and stored by the field type (documented in `docs/ruleset.md`).
- The Minimap option's label is now "Show a minimap".
- `src/shared/options.ts` exports `generalOptionFields` (the plain options) instead of `nodeGraphOptions`; `resolveFieldOptions()`, the defaults and `RULESET_TEMPLATE` are unchanged.
- The app bundle grows by about 61 KB (16 KB gzipped); the API bundle is unchanged.

## 0.1.1

- First release published by the manual Publish workflow through npm trusted publishing, which validates the trusted publisher configuration. No functional changes.

## 0.1.0

- Initial release. A bundle with the **Node Graph** interface (`node-graph`) for `json` fields, the **Node Graph Summary** display (`node-graph-summary`) and the `node-graph-guard` hook.
- The editor opens in a widened stock drawer: a node type palette, a Vue Flow 1.48.2 canvas styled like the Flows editor, an inspector with Directus form fields, an issues panel, undo and redo, zoom and fit, and an optional minimap. Connections are checked while they are drawn.
- What a graph may contain is set per field with a JSON ruleset: node types, fields, ports, outputs generated from a repeater, data types, edge types, connection and graph rules, severities and a starter graph. See `docs/ruleset.md` and the rulesets in `examples/`.
- The hook validates graphs on item create and update with the field's enforcement policy (Ratchet, Reject, Log only or Off; default Ratchet), recomputes the stored `meta`, and refuses field options whose ruleset does not compile.
- Targets Directus `^11.15.0`. Built against 11.17.4.
