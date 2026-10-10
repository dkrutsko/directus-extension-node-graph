# Changelog

## 0.1.1

- First release published by the manual Publish workflow through npm trusted publishing, which validates the trusted publisher configuration. No functional changes.

## 0.1.0

- Initial release. A bundle with the **Node Graph** interface (`node-graph`) for `json` fields, the **Node Graph Summary** display (`node-graph-summary`) and the `node-graph-guard` hook.
- The editor opens in a widened stock drawer: a node type palette, a Vue Flow 1.48.2 canvas styled like the Flows editor, an inspector with Directus form fields, an issues panel, undo and redo, zoom and fit, and an optional minimap. Connections are checked while they are drawn.
- What a graph may contain is set per field with a JSON ruleset: node types, fields, ports, outputs generated from a repeater, data types, edge types, connection and graph rules, severities and a starter graph. See `docs/ruleset.md` and the rulesets in `examples/`.
- The hook validates graphs on item create and update with the field's enforcement policy (Ratchet, Reject, Log only or Off; default Ratchet), recomputes the stored `meta`, and refuses field options whose ruleset does not compile.
- Targets Directus `^11.15.0`. Built against 11.17.4.
