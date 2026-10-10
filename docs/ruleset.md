# Ruleset reference

A ruleset says what a node-graph field may contain: which node types exist, what fields and ports they have, which connections are allowed, and which problems are errors or warnings. The editor, the field row, the summary display and the server-side hook all use the same ruleset and the same checks, so they always agree.

This page describes the format, for people who write rulesets by hand and for anyone who wants to know what the ruleset editor in the field settings writes: [the options form](#the-options-form) and its JSON editor edit the same document. Two complete rulesets are in the repository, and both are offered by **Load Example**:

- [`examples/approval-workflow.json`](../examples/approval-workflow.json): the "Approval workflow" ruleset. It uses every feature at least once.
- [`examples/simple-approval.json`](../examples/simple-approval.json): a smaller ruleset with four node types and one edge type, a good starting point.

## Contents

1. [Where the ruleset lives](#where-the-ruleset-lives)
   - [The options form](#the-options-form)
2. [How a ruleset is checked](#how-a-ruleset-is-checked)
3. [Top level](#top-level)
4. [Data types](#data-types)
5. [Node types](#node-types)
6. [Fields](#fields)
7. [Ports](#ports)
8. [Dynamic outputs](#dynamic-outputs)
9. [Edge types](#edge-types)
10. [Connection rules](#connection-rules)
11. [Pair rules](#pair-rules)
12. [Graph rules](#graph-rules)
13. [Severity overrides](#severity-overrides)
14. [Starter graph](#starter-graph)
15. [Templates](#templates)
16. [Issue codes](#issue-codes)
17. [The stored graph document](#the-stored-graph-document)
18. [Server-side enforcement](#server-side-enforcement)
19. [What the hook does not see](#what-the-hook-does-not-see)

## Where the ruleset lives

The ruleset is the **Ruleset** option of a Node Graph field (Settings, Data Model, the field, Interface). Directus stores it in `directus_fields.options.ruleset`, so it travels with schema snapshots. It is one JSON object in the format below. The field settings edit it with [the options form](#the-options-form), which stores the object; a ruleset written through the API may also be a JSON string, and both forms are accepted.

The field's other options are resolved with defaults whenever they are read, because Directus does not save an option the admin never touched:

| Option | Key | Default | Notes |
|---|---|---|---|
| Ruleset | `ruleset` | none | Object or JSON string. Without one the field shows a notice instead of the editor. |
| Summary Template | `template` | `{{nodeCount}} nodes · {{edgeCount}} connections` | See [Templates](#field-row-and-display-summary). A blank value means the default. |
| Placeholder | `placeholder` | "No graph yet" | Shown while the field is empty. |
| Editor Width | `editorWidth` | `wide` | `standard`, `wide` or `full`. |
| Server Enforcement | `enforcement` | `ratchet` | `ratchet`, `reject`, `log` or `off`. See [Server-side enforcement](#server-side-enforcement). |
| Snap to Grid | `snapToGrid` | `true` | |
| Grid Size | `gridSize` | `18` | Canvas units; rounded and clamped to 4-96. |
| Minimap | `showMinimap` | `false` | |

### The options form

The interface options show the plain options above, then the ruleset as a form of stock Directus inputs: collapsible sections, Repeaters (the `list` interface) for lists, and the same interface and display pickers as the stock Repeater's "Edit Fields". **Edit as JSON** opens the whole ruleset in the code editor instead, and **Load Example** replaces it with one of the examples (asking first). Both edit the same stored document; the form is only another view of it.

| Form | Ruleset keys |
|---|---|
| Ruleset section | `key`, `name`, `version`, `direction` |
| Data Types section, one row per type | `dataTypes[]`: `key`, `label`, `color`, `accepts` |
| Node Types section, one drawer per type | `nodeTypes[]`: `key`, `label`, `icon`, `color`, `category`, `description` |
| … Behaviour | `deprecated`, `deletable`, `limits.minInstances`, `limits.maxInstances` |
| … Card | `titleTemplate`, `summaryFields` |
| … Fields, one drawer per field | `fields[]`: `field`, `name`, `type`, `meta.width`, `meta.required`, `meta.readonly`, `meta.hidden`, `meta.note`, `schema.default_value` (Default Value), `meta.interface` and `meta.options` (Interface Options), `meta.display` and `meta.display_options` (Display Options) |
| … Ports: Inputs and Outputs | `inputs[]`, `outputs[]`: `key`, `label`, `dataType`, `side`, `minConnections`, `maxConnections`, and for outputs `edgeTypes` (Edge Types, and New Connections for its first entry) |
| … Dynamic Outputs | `dynamicOutputs`: `field` (Source Field), `labelTemplate`, `placement`, and `port` (the port settings) |
| Edge Types section, one drawer per type | `edgeTypes[]`: `key`, `label`, `style.path`, `style.marker`, `style.color`, `style.dashed`, `style.animated`, `labelTemplate`, `fields` (as for node types) |
| Connection Rules section | `connectionRules`: `defaultEdgeType`, `typeCheck`, `allowSelfLoops`, `allowCycles`, `allowMultiEdges`, `pairs.mode` (Pair Rules), `pairs.rules[]` (Rules: `source`, `sourcePort`, `target`, `targetPort`, `message`) |
| Graph Rules section | `graphRules`: `minNodes`, `maxNodes`, `maxEdges`, `entryNodeTypes`, `requireReachableFromEntry`, `requireConnected` |
| Severity Overrides section, one row per code | `severity`: `{ "<code>": "<severity>" }` |
| Starter Graph section | `starter.nodes[]` (`ref`, `type`, `position.x`, `position.y`, `data`) and `starter.edges[]` (`source`, `sourceHandle`, `target`, `targetHandle`, `type`, `data`) |

`format` and `schemaVersion` are not shown; they are kept as they are, and the examples include them.

What the form writes:

- **Only what you change.** Every list row keeps the stored object it came from, and a change rebuilds the object from it, so keys the form does not show (`meta.conditions`, `meta.sort`, keys for a later version, notes) stay, and so do the order of lists and of keys. Keys that are new to an object go where this page lists them.
- **No defaults.** A value equal to its documented default (`deletable: true`, `typeCheck: "strict"`, `width: "full"`, …) is written only if the key was already there; the form shows the default for an absent key. An emptied value (an empty text, a cleared number, an empty list) removes the key.
- **Incomplete rows stay.** A node type without a key yet, or a field without a type, is stored as it is, and the problems list says what is missing. Only a severity override without an issue code cannot be stored (there is no key to store it under); the form keeps it and lists it under "Not saved as entered".
- **References are not renamed.** Changing a key does not change the pair rules, entry node types, port edge types or starter graph that refer to it. Selects list such values as "(not defined)", and the problems list reports them.
- **Default values are typed as text** and stored by the field's type: `true` or `false` for `boolean`; a number for `integer` (whole numbers only) and `float`; JSON for `json` (`{"a": 1}`, `["a"]`, `3`, `"text"`); a JSON list or comma-separated values for `csv`, stored as a list of text; and the text as it is for every other type (`bigInteger` and `decimal` stay text, as in the Directus app). Text that does not fit the type is stored as text and listed under "Not saved as entered". An unchanged default is kept exactly as stored, whatever its type.
- **Nothing on open.** Opening the field settings writes nothing; only an edit does.

A ruleset the form cannot show without changing it (a list that is not a list, a flag that is not `true` or `false`, a version that is text, a key such as `__proto__`), or text that is not JSON, opens in the JSON editor in place of the sections, with the reasons and the problems. Nothing is changed until you apply a fix. A ruleset stored as JSON text opens in the form and is stored as an object at the first change.

## How a ruleset is checked

A ruleset is compiled before anything uses it. Compilation is strict: it reports every problem it finds, and a ruleset with any problem is not used at all. The field row then shows "This field's ruleset is invalid" with the problems (the first 20) and no editor, and the hook falls back to structural checks for that field's values. Saving the field options with a ruleset that does not compile is refused (see [Ruleset check on field save](#ruleset-check-on-field-save)).

Each problem is one line, `path: message.`, where the path points into the ruleset:

```text
nodeTypes[0].key: "a b" must be at most 64 letters, digits, "_" or "-".
nodeTypes[2].fields[0].meta.interface: "select-dropdown-m2o" needs a relation or a collection and cannot be used inside a node.
connectionRules.pairs.rules[0].source: "ghost" is not a defined node type.
severity.bogus: is not a known issue code.
```

An empty string, `null` or a missing ruleset gives `No ruleset is configured.`, and text that is not JSON gives `The ruleset is not valid JSON (...)`.

Rules that apply everywhere:

- **Unknown keys are kept** at every level and ignored, so a ruleset can carry notes or keys for a later version. The exceptions are `__proto__`, `constructor` and `prototype`, which are refused wherever they appear (`nodeTypes[0].__proto__: the key is not allowed.`). Values nested more than 64 levels deep are refused too.
- **Keys** (node type, edge type, data type, port and field keys) are 1 to 64 characters of letters, digits, `_` and `-`, and do not start with `-` (`^[A-Za-z0-9_][A-Za-z0-9_-]*$`). Dots are not allowed: they are reserved for the keys of [dynamic outputs](#dynamic-outputs). Keys are unique within their list.
- **Reserved names** cannot be used as keys: `__proto__`, `constructor`, `prototype`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `toString` and `valueOf`. Field keys also cannot be `_user` or `_date`, which content versioning adds to saved values.
- **Text** (labels, descriptions, categories, templates, messages, field names) is a string of at most 2,000 characters.
- **Colours** are CSS colours of at most 200 characters made of letters, digits, spaces and `# ( ) , . % _ -`: hex (`#6644ff`), names (`red`), `rgb()`/`hsl()` with commas, `color-mix()` and `var(--theme--...)`. Quotes, `;`, `/`, braces and the resource-loading functions (`url()`, `image()`, `image-set()`, `cross-fade()`, `element()`, `paint()`, `src()`, `expression()`) are refused, so `rgb(0 0 0 / 50%)` is not accepted. Prefer Directus theme variables such as `var(--theme--primary)`, `var(--theme--secondary)`, `var(--theme--warning)` or `var(--theme--success)`: they follow light and dark mode and custom themes.
- **Icons** are Material Symbols names as `<v-icon>` takes them: lowercase letters, digits and `_`, such as `task_alt`.
- **Booleans** are `true` or `false`; whole numbers are integers of 0 or more unless stated otherwise.
- **Limits**: at most 500 node types, 100 inputs and 100 outputs per node type, and 200 fields per node or edge type.

## Top level

| Key | Type | Default | Notes |
|---|---|---|---|
| `format` | `"directus-node-graph-ruleset"` | | Optional; if present it must be exactly this. |
| `schemaVersion` | `1` | | Optional; if present it must be `1`. |
| `key` | text | required | Identifies the ruleset, up to 200 characters. It is stamped on every graph saved against it. |
| `version` | whole number | `1` | Bump it when you change the ruleset. Stamped on graphs next to `key` and shown in the editor's subtitle ("Approval workflow · v1"). |
| `name` | text | `key` | Shown in the editor's subtitle and in the inspector. |
| `direction` | `"LR"` or `"TB"` | `"LR"` | Left to right or top to bottom. Decides the default [port sides](#ports). |
| `dataTypes` | list | `[]` | [Data types](#data-types) for ports. |
| `nodeTypes` | list | required | [Node types](#node-types), at least one. |
| `edgeTypes` | list | one implicit type | [Edge types](#edge-types). Without any, every connection uses a built-in type `default` labelled "Connection". |
| `connectionRules` | object | all defaults | [Connection rules](#connection-rules) and [pair rules](#pair-rules). |
| `graphRules` | object | none | [Graph rules](#graph-rules). |
| `severity` | object | built-in severities | [Severity overrides](#severity-overrides). |
| `starter` | object | see below | What "Create" seeds. See [Starter graph](#starter-graph). |

The smallest ruleset that compiles:

```json
{
	"key": "tiny",
	"nodeTypes": [
		{ "key": "step", "inputs": [{ "key": "in" }], "outputs": [{ "key": "out" }] }
	]
}
```

It is named "tiny", version 1, runs left to right, has one node type labelled "Step" whose ports are labelled `in` and `out` and accept anything, and one edge type `default`. "Create" opens an empty graph, because no type asks for a minimum number of nodes. A ruleset meant to last starts with the full header:

```json
{
	"format": "directus-node-graph-ruleset",
	"schemaVersion": 1,
	"key": "approval-workflow",
	"version": 1,
	"name": "Approval workflow",
	"direction": "LR",
	"nodeTypes": [
		{ "key": "step", "label": "Step" }
	]
}
```

## Data types

Data types say which outputs may connect to which inputs. A port names its data type with `dataType`; a port without one has the built-in type `any`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `key` | key | required | Unique. `any` is built in and cannot be redefined. |
| `label` | text | the key in title case | Shown in messages ("output "Escalate" (Event) cannot connect to input "In" (Control flow).") and in the inspector. `control_flow` becomes "Control Flow". |
| `color` | colour | `var(--theme--foreground-subdued)` | The ring of ports of this type, and the colour of connections from them when the edge type sets no colour. |
| `accepts` | list of data type keys | `[]` | Source types that an input of this type also accepts. `"any"` in the list accepts everything. Keys may refer to types declared later. |

With `connectionRules.typeCheck` at `strict` (the default), a connection is allowed when the input's type and the output's type are the same, when either is `any`, or when the input's type lists the output's type (or `any`) in `accepts`. `accepts` is one-way: it belongs to the receiving side.

```json
"dataTypes": [
	{ "key": "flow", "label": "Control flow", "color": "var(--theme--primary)" },
	{ "key": "event", "label": "Event", "color": "var(--theme--warning)" },
	{ "key": "signal", "accepts": ["event"] }
]
```

Here an `event` output may connect to a `signal` input, but a `signal` output may not connect to an `event` input. `signal` gets the label "Signal" and the neutral colour. `any` is labelled "Any" and uses the neutral colour.

## Node types

| Key | Type | Default | Notes |
|---|---|---|---|
| `key` | key | required | Unique. Stored in each node's `type`. |
| `label` | text | the key in title case | The palette entry, the card's headline, the inspector and messages. |
| `icon` | icon name | `category` for a type with a category, else `account_tree` | Shown on the card, in the palette and in the inspector. |
| `color` | colour | `var(--theme--primary)` | Tints the card's icon tile and the palette icon. |
| `description` | text | | The palette entry's tooltip. |
| `category` | text | | Palette group. Types without a category come first, without a heading. |
| `deprecated` | boolean | `false` | Hidden from the palette, so users cannot add new ones. Existing nodes keep working, show "· Deprecated" and a dashed frame, and raise a `deprecated_node_type` warning. Values written through the API may still contain them; they only get the warning. |
| `deletable` | boolean | `true` | `false` keeps the editor from deleting nodes of this type. The hook does not enforce it; use `limits.minInstances` if a node must exist. |
| `limits.minInstances` | whole number | | Fewer nodes of this type raise `min_instances` (warning). Also decides what "Create" seeds when the ruleset has no starter. |
| `limits.maxInstances` | whole number | | More nodes raise `max_instances` (error). While that code is an error, the palette disables the type at the limit and the editor refuses more. Must not be smaller than `minInstances`. |
| `titleTemplate` | text | | The card's title. Without it, or when all its tokens are empty, the title is the type's label. See [Node titles](#node-titles). |
| `summaryFields` | list of field keys | `[]` | Fields shown on the card under the title, one row per field that has a value, labelled with the field's name. Each key must be a field of this type. |
| `fields` | list | `[]` | [Fields](#fields) edited in the inspector, stored in the node's `data`. |
| `inputs` | list | `[]` | Input [ports](#ports). |
| `outputs` | list | `[]` | Output [ports](#ports). |
| `dynamicOutputs` | object | | Outputs generated from a repeater field. See [Dynamic outputs](#dynamic-outputs). |

```json
{
	"key": "review",
	"label": "Review",
	"icon": "task_alt",
	"color": "var(--theme--secondary)",
	"category": "Steps",
	"description": "Someone reviews the request.",
	"limits": { "maxInstances": 10 },
	"titleTemplate": "Review by {{reviewer}}",
	"summaryFields": ["reviewer", "due_days"],
	"fields": [
		{
			"field": "reviewer",
			"name": "Reviewer",
			"type": "string",
			"meta": {
				"interface": "select-dropdown",
				"width": "half",
				"required": true,
				"options": {
					"choices": [
						{ "text": "Team lead", "value": "team_lead" },
						{ "text": "Security", "value": "security" }
					]
				}
			}
		},
		{
			"field": "due_days",
			"name": "Due in (days)",
			"type": "integer",
			"meta": { "interface": "input", "width": "half", "options": { "min": 0 } },
			"schema": { "default_value": 3 }
		}
	],
	"inputs": [{ "key": "in", "label": "In", "dataType": "flow", "minConnections": 1 }],
	"outputs": [{ "key": "next", "label": "Next", "dataType": "flow", "maxConnections": 1, "edgeTypes": ["flow", "timeout"] }]
}
```

A node of this type with `{ "reviewer": "security", "due_days": 3 }` is titled "Review by Security", and its card lists Reviewer "Security" and Due in (days) "3" under the ports. It uses the `flow` data type and the `flow` and `timeout` edge types, which the ruleset must declare.

## Fields

Node types and edge types declare their fields in the Directus field shape, and the inspector renders them with the app's own form, the way the stock Repeater renders its sub-fields. Values are stored in the element's `data` under the field key.

| Key | Type | Default | Notes |
|---|---|---|---|
| `field` | key | required | Unique within the type. Not `_user` or `_date`. |
| `name` | text | the key in title case | The form label, and the label in messages and card summaries. |
| `type` | text | required | One of `string`, `text`, `integer`, `bigInteger`, `float`, `decimal`, `boolean`, `json`, `csv`, `uuid`, `hash`, `date`, `time`, `dateTime`, `timestamp`, or `alias` for presentation-only fields that hold no data (a notice or a divider). |
| `meta.interface` | interface id | the form's default for the type | Any interface that works without a collection. Interfaces that need a relation or a collection-backed group are refused: `file`, `file-image`, `files`, `list-m2a`, `list-m2m`, `list-o2m`, `list-o2m-tree-view`, `select-dropdown-m2o`, `translations`, `group-accordion`, `group-detail`, `group-raw` and `group-tabs`. |
| `meta.options` | object | | The interface's options, for example `choices` for selects or `fields` for a `list` repeater. |
| `meta.width` | `half`, `half-left`, `half-right`, `full`, `fill` | `full` | Width in the inspector form. |
| `meta.required` | boolean | `false` | An empty value raises `field_required` (error). |
| `meta.readonly` | boolean | `false` | Read-only in the inspector. |
| `meta.hidden` | boolean | `false` | Not shown in the inspector, and never reported as missing. |
| `meta.note`, `meta.conditions`, `meta.display`, `meta.display_options`, `meta.sort` | | | Passed to the form unchecked. |
| `schema.default_value` | any JSON | | Filled in when a node or connection is created (deep-copied). `null` defaults are skipped, as in the Directus form. The options form edits it as text, converted by `type` (see [The options form](#the-options-form)). |

Validation checks only `required`: a required field is missing when its value is absent, `null`, `""` or `[]`. Hidden fields and `alias` fields are never reported. Values are not checked against the field's `type` or the interface's options (such as `min`); the inspector form enforces those while editing, but the hook does not.

Selects and other interfaces with `meta.options.choices` show their choice text in titles, labels and card summaries, so a stored `team_lead` reads "Team lead".

```json
"fields": [
	{ "field": "title", "name": "Title", "type": "string", "meta": { "interface": "input", "width": "full", "required": true } },
	{ "field": "notes", "name": "Notes", "type": "text", "meta": { "interface": "input-multiline" } },
	{ "field": "urgent", "name": "Urgent", "type": "boolean", "meta": { "interface": "boolean", "width": "half" }, "schema": { "default_value": false } },
	{ "field": "help", "type": "alias", "meta": { "interface": "presentation-notice", "options": { "text": "Titles show on the card." } } }
]
```

## Ports

`inputs` and `outputs` are lists of ports. Connections always run from an output to an input.

| Key | Type | Default | Notes |
|---|---|---|---|
| `key` | key | required | Unique among the type's inputs, or among its outputs; an input and an output may share a key. Stored in each connection's `sourceHandle` or `targetHandle`. |
| `label` | text | the key, unchanged | Shown next to the port on the card and in messages. |
| `dataType` | data type key or `"any"` | `"any"` | See [Data types](#data-types). |
| `side` | `left`, `right`, `top`, `bottom` | inputs `left` and outputs `right` for `LR`; inputs `top` and outputs `bottom` for `TB` | Left and right ports get a labelled row on the card; top and bottom ports show their label as a tooltip. |
| `minConnections` | whole number | `0` | Fewer connections raise `min_connections` (warning). |
| `maxConnections` | whole number of 1 or more | unlimited | More connections raise `max_connections` (error). While that code is an error, the editor refuses the extra connection. Must not be smaller than `minConnections`. |
| `edgeTypes` | list of edge type keys | every edge type | Outputs only. The edge types a connection from this output may have; the first is the type of new connections. Without it, every edge type is allowed and the ruleset's default edge type comes first. |

Every connection that uses a declared port counts against its limits, even a connection that is invalid for another reason or whose other end is missing. Renaming a port key in the ruleset leaves existing connections pointing at a port that no longer exists: they are kept, drawn on a dashed placeholder handle and reported as `unknown_port` errors until they are reconnected or deleted.

```json
"inputs": [
	{ "key": "in", "label": "In", "dataType": "flow", "minConnections": 1 },
	{ "key": "trigger", "label": "Trigger", "dataType": "event" }
],
"outputs": [
	{ "key": "next", "label": "Next", "dataType": "flow", "maxConnections": 1, "edgeTypes": ["flow", "timeout"] }
]
```

## Dynamic outputs

A node type can generate outputs from a repeater field: every item of the field's list becomes one output. The example ruleset's Condition uses this for its branches.

| Key | Type | Default | Notes |
|---|---|---|---|
| `field` | field key | required | A field of this node type with type `json`, normally edited with the stock `list` (Repeater) interface. Its value must be a list; anything else generates no outputs. |
| `labelTemplate` | text | | The output's label, rendered against the list item (`{{label}}` reads the item's `label`). Select sub-fields declared in the repeater's `meta.options.fields` show their choice text. Without a template, an item that is a plain string or number is its own label. |
| `port` | object | | Settings for every generated output: `dataType`, `side`, `minConnections`, `maxConnections` and `edgeTypes`, as for [ports](#ports). |
| `placement` | `"start"` or `"end"` | `"end"` | Whether the generated outputs come before or after the type's static outputs. |

Generated outputs have the keys `<field>.<index>`, counting from 0 (`branches.0`, `branches.1`, ...), which cannot clash with static keys because those have no dots. An item whose label comes out empty is labelled `#1`, `#2` and so on. [Pair rules](#pair-rules) can match every generated output with `<field>.*`.

Keys follow the item's position, not its identity: reordering the items moves their connections to other branches, and deleting an item shifts the items after it, so the connections of the last key end up on a port that no longer exists (an `unknown_port` error, kept rather than dropped). The example ruleset says so in the field's note.

```json
"fields": [
	{ "field": "label", "name": "Label", "type": "string", "meta": { "interface": "input", "width": "full" } },
	{
		"field": "branches",
		"name": "Branches",
		"type": "json",
		"meta": {
			"interface": "list",
			"note": "Each branch becomes an output. Reordering branches moves their connections.",
			"options": {
				"template": "{{label}}",
				"addLabel": "Add branch",
				"fields": [{ "field": "label", "name": "Label", "type": "string", "meta": { "interface": "input" } }]
			}
		}
	}
],
"outputs": [{ "key": "else", "label": "Otherwise", "dataType": "flow", "maxConnections": 1 }],
"dynamicOutputs": {
	"field": "branches",
	"labelTemplate": "{{label}}",
	"placement": "start",
	"port": { "dataType": "flow", "maxConnections": 1 }
}
```

With `"branches": [{ "label": "Production" }, { "label": "" }]` the node has the outputs `branches.0` "Production", `branches.1` "#2" and `else` "Otherwise", in that order.

## Edge types

| Key | Type | Default | Notes |
|---|---|---|---|
| `key` | key | required | Unique. Stored in each connection's `type`. |
| `label` | text | the key in title case | The inspector's type select and messages. |
| `style.path` | `bezier`, `step`, `straight` | `bezier` | `step` draws right angles with 10 px rounded corners, like the Flows editor's arrows. |
| `style.color` | colour | the source port's data type colour | Errors and warnings recolour a connection, and selection draws it in the primary colour. |
| `style.dashed` | boolean | `false` | |
| `style.animated` | boolean | `false` | The dashes move toward the target; they stand still for users who prefer reduced motion. |
| `style.marker` | `arrow` or `none` | `arrow` | `arrow` is an open chevron at the target end. |
| `labelTemplate` | text | | The label pill on the connection. An empty result shows no pill. See [Connection labels](#connection-labels). |
| `fields` | list | `[]` | [Fields](#fields) edited in the inspector when the connection is selected, stored in the connection's `data`. |

A ruleset without edge types (or with an empty list) gets one implicit type, `{ "key": "default", "label": "Connection" }`, drawn with the defaults above.

```json
"edgeTypes": [
	{
		"key": "flow",
		"label": "Flow",
		"style": { "path": "bezier", "marker": "arrow" },
		"labelTemplate": "{{label}}",
		"fields": [{ "field": "label", "name": "Label", "type": "string", "meta": { "interface": "input" } }]
	},
	{
		"key": "timeout",
		"label": "Timeout",
		"style": { "path": "step", "dashed": true, "color": "var(--theme--warning)" },
		"labelTemplate": "after {{after_hours}} h",
		"fields": [{ "field": "after_hours", "name": "After (hours)", "type": "integer", "meta": { "interface": "input" } }]
	}
]
```

## Connection rules

| Key | Type | Default | Notes |
|---|---|---|---|
| `defaultEdgeType` | edge type key | the first edge type | The type of stored connections that have no `type`, and the first type offered by outputs that do not list `edgeTypes`. An output that lists `edgeTypes` uses its own first entry for new connections. |
| `typeCheck` | `"strict"` or `"off"` | `"strict"` | `strict` raises `type_mismatch` when an input's data type does not accept the output's. `off` ignores data types (they still colour the ports). |
| `allowSelfLoops` | boolean | `false` | A connection from a node to itself raises `self_loop`. |
| `allowCycles` | boolean | `true` | With `false`, every connection that lies on a loop of two or more nodes raises `cycle`. Self loops are only reported as `self_loop`. |
| `allowMultiEdges` | boolean | `false` | A second connection between the same output and the same input raises `multi_edge` (the first one is fine). |
| `pairs` | object | | [Pair rules](#pair-rules). |

```json
"connectionRules": {
	"defaultEdgeType": "flow",
	"typeCheck": "strict",
	"allowSelfLoops": false,
	"allowCycles": true,
	"allowMultiEdges": false,
	"pairs": { "mode": "deny", "rules": [{ "source": "start", "target": "end", "message": "Start cannot go straight to End." }] }
}
```

While a connection is drawn, the editor checks each port it could end on and dims the ones that would be refused; releasing over one shows the reason. The live check refuses exactly what would be saved as an error on the new connection. Checks run in this order, so the message names the most basic problem: a missing node, an unknown node type, an unknown port or a reversed connection, a self loop, an unknown edge type, an edge type the output does not allow, a data type mismatch, a pair rule, a duplicate connection, a port's connection limit (output, then input), a loop.

## Pair rules

Pair rules allow or deny connections between particular node types and ports.

| Key | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"allow"` or `"deny"` | required | `deny`: connections that match a rule are not allowed. `allow`: only connections that match a rule are allowed. |
| `rules` | list | required | The rules below. |
| `rules[].source` | node type key or `"*"` | any type | The output's node type. |
| `rules[].sourcePort` | output key, `"<field>.*"` or `"*"` | any port | `<field>.*` matches every [dynamic output](#dynamic-outputs) of that repeater field. |
| `rules[].target` | node type key or `"*"` | any type | The input's node type. |
| `rules[].targetPort` | input key or `"*"` | any port | |
| `rules[].message` | text | | In `deny` mode, the message for connections this rule refuses. |

A rule matches a connection when all four of its members match; an omitted member matches anything. In `deny` mode the first matching rule refuses the connection with its `message`, or with "<Source label> cannot connect to <Target label>." when it has none. In `allow` mode a connection that matches no rule is refused with that default message; rule messages are not used. Either way the issue is `pair_not_allowed` (error).

The compiler checks that `source` and `target` name defined node types, and, when a rule names both a specific type and a specific port, that the port exists on that type (an output for `sourcePort`, including `<field>.*` for a type with dynamic outputs; an input for `targetPort`).

```json
"pairs": {
	"mode": "allow",
	"rules": [
		{ "source": "start" },
		{ "target": "end" },
		{ "source": "condition", "sourcePort": "branches.*" },
		{ "source": "*", "target": "task" }
	]
}
```

## Graph rules

| Key | Type | Default | Notes |
|---|---|---|---|
| `minNodes` | whole number | | Fewer nodes raise `min_nodes` (warning). Must not be larger than `maxNodes`. |
| `maxNodes` | whole number | | More nodes raise `max_nodes` (error). Every node counts, including unknown types and duplicates. |
| `maxEdges` | whole number | | More connections raise `max_edges` (error). |
| `entryNodeTypes` | list of node type keys | | The types a graph starts from, used by `requireReachableFromEntry`. |
| `requireReachableFromEntry` | boolean | `false` | Every node must be reachable from a node of an entry type by following connections forward; others raise `unreachable` (warning). If the graph has nodes but none of an entry type, one graph-level `unreachable` warning is raised instead. Needs at least one entry type. |
| `requireConnected` | boolean | `false` | Every node needs at least one connection, in or out; others raise `not_connected` (warning). |

Reachability follows every connection whose two nodes exist, including connections with unknown ports or other errors.

```json
"graphRules": {
	"entryNodeTypes": ["start"],
	"requireReachableFromEntry": true,
	"maxNodes": 200,
	"maxEdges": 400
}
```

## Severity overrides

Every [issue code](#issue-codes) has a built-in severity. `severity` changes it per code to `"error"`, `"warning"` or `"off"`:

```json
"connectionRules": { "allowCycles": false },
"severity": { "cycle": "warning", "min_connections": "off" }
```

Here loops may be drawn and are listed as warnings, and unconnected required ports are not reported at all.

- **Everywhere:** the new severity is what the issues panel, the field row's counts, the display's error icon and the hook see. `off` removes the issue entirely. Only errors can block a save; warnings never do.
- **Drawing connections:** rule checks (`self_loop`, `edge_type_not_allowed`, `type_mismatch`, `pair_not_allowed`, `multi_edge`, `max_connections`, `cycle`) refuse a connection only while their code is an error. Structural problems (a missing node, an unknown node type, port or edge type, a connection from an input to an output) are always refused, whatever their severity, because such a connection cannot be drawn or typed.
- **Adding nodes:** the palette disables a type at `limits.maxInstances`, and the editor refuses more, only while `max_instances` is an error.
- **`invalid_document`:** turning it down hides the problems of values that could only be read by dropping data. The hook still never replaces such a value with the reduced copy (see [Server-side enforcement](#server-side-enforcement)), but with the code at `warning` or `off` it no longer refuses them either, so leave it an error.

An unknown code gives `severity.<code>: is not a known issue code.`

## Starter graph

`starter` is what "Create" seeds when a user starts a new graph.

| Key | Type | Notes |
|---|---|---|
| `nodes` | list, required | The nodes to create. |
| `nodes[].ref` | text, required | A name for the node, unique within the starter, used by `edges`. Replaced by a generated id. |
| `nodes[].type` | node type key, required | |
| `nodes[].position` | `{ "x": number, "y": number }`, required | Canvas units at 100% zoom. Multiples of the grid size (18 by default) line up with the grid. |
| `nodes[].data` | object | Field values, merged over the type's field defaults. |
| `edges` | list | The connections to create. |
| `edges[].source`, `edges[].target` | node refs, required | |
| `edges[].sourceHandle` | output key, required | An output of the source's type, including [dynamic outputs](#dynamic-outputs) generated from the starter node's `data`. |
| `edges[].targetHandle` | input key, required | An input of the target's type. |
| `edges[].type` | edge type key | Must be allowed on the output. Default: the output's first allowed type. |
| `edges[].data` | object | Field values, merged over the edge type's field defaults. |

The starter must be a graph a user can save, because the default `ratchet` policy refuses any error on a new item. Besides the references above, the compiler checks that no node type appears more often than its `limits.maxInstances` (while `max_instances` is an error), and that every starter edge, in order, passes the same check as a connection drawn by hand against the edges before it: a denied pair or a second edge on a single-connection output is refused (`starter.edges[0]: Start cannot go straight to End.`). Warnings, such as an unconnected End, and empty required fields are allowed: those are for the user to finish.

```json
"starter": {
	"nodes": [
		{ "ref": "start", "type": "start", "position": { "x": 0, "y": 0 }, "data": { "title": "Request received" } },
		{ "ref": "review", "type": "task", "position": { "x": 360, "y": 0 }, "data": { "title": "Review" } },
		{ "ref": "end", "type": "end", "position": { "x": 720, "y": 0 } }
	],
	"edges": [
		{ "source": "start", "sourceHandle": "next", "target": "review", "targetHandle": "in" },
		{ "source": "review", "sourceHandle": "next", "target": "end", "targetHandle": "in", "type": "timeout", "data": { "after_hours": 24 } }
	]
}
```

Without a `starter`, "Create" seeds `limits.minInstances` nodes of every type that is not deprecated, in the order the types are declared, in a row 360 units apart (along x for `LR`, along y for `TB`), with no connections. If no type sets `minInstances`, the graph starts empty. Either way the nodes get fresh ids and their field defaults, and the graph is stamped with the ruleset's `key` and `version`.

## Templates

Titles, connection labels, dynamic output labels and the field row's summary are rendered from templates with `{{ token }}` placeholders, the syntax Directus display templates use.

- A token is a path of one or more segments of letters, digits, `_`, `$` and `-`, separated by dots: `{{ title }}`, `{{ customer.name }}`, `{{ branches.0.label }}` (list items by index). Spaces just inside the braces are allowed. Anything else, such as spaces inside the path, brackets or expressions, renders empty.
- Paths only read the value's own data. `__proto__`, `constructor` and `prototype` segments, and anything that does not exist, render empty.
- The output is plain text, never HTML. Control characters other than tab and newline are removed.
- Strings and numbers render as they are. When the token's first segment names a declared field, values are shown the way the form shows them: the choice text for fields with `meta.options.choices` (values compared as text) and Yes or No for booleans. Lists are joined with ", ", leaving out empty items; lists nested more than eight levels deep render empty. Objects render empty: use a path into them instead.

### Node titles

`titleTemplate` is rendered against the node's `data`, plus `{{ $type }}` for the type's label. If the template has tokens and every one of them comes out empty, the title is the type's label: `End: {{outcome}}` shows "End" until an outcome is picked, and `Approval by {{approver}}` shows "Approval". Whitespace runs are collapsed into single spaces, and titles are cut at 120 characters with an ellipsis. Without a `titleTemplate` the title is the label. A node of an unknown type is titled with its raw type key.

Titles appear on the card, in the inspector, in issue messages and in the accessible names of connections.

### Connection labels

`labelTemplate` is rendered against the connection's `data`, plus `{{ $type }}` for the edge type's label, with the same rules as titles, except that an empty result means no label pill: `after {{after_hours}} h` shows nothing until the hours are set.

### Dynamic output labels

`dynamicOutputs.labelTemplate` is rendered against one item of the repeater's list. See [Dynamic outputs](#dynamic-outputs).

### Field row and display summary

The field's **Summary Template** option sets the text of the field row in the item form and of the "Node Graph Summary" display in tables. Its tokens:

| Token | Value |
|---|---|
| `{{nodeCount}}` | Number of nodes. |
| `{{edgeCount}}` | Number of connections. |
| `{{errorCount}}` | Number of errors. |
| `{{warningCount}}` | Number of warnings. |
| `{{counts.<type key>}}` | Nodes of that type. Every type of the ruleset is present, so a type without nodes renders `0`. |
| `{{ruleset.key}}`, `{{ruleset.name}}`, `{{ruleset.version}}` | The field's ruleset; empty when it does not compile. |

Without a template the text is "3 nodes · 2 connections", with singular words for one ("1 node · 1 connection"). `{{counts.task}} tasks · {{errorCount}} errors` gives "1 tasks · 0 errors": the template has no plural forms. Whitespace runs are collapsed.

Card summaries (`summaryFields`) are not templates: each row is the field's name over its formatted value, and empty values are left out.

## Issue codes

| Code | Default | Attached to | Raised when |
|---|---|---|---|
| `invalid_document` | error | graph | The value could not be read without dropping data: it is not JSON or not a graph, it has another format or version, elements have no usable id or endpoints, keys such as `__proto__` were removed, `data` is not an object. One issue per problem. See [Normalisation](#normalisation). |
| `duplicate_id` | error | node or connection | Two nodes, two connections, or a node and a connection share an id. Only the first element with an id is drawn and checked for connections. |
| `unknown_node_type` | error | node | The node's type is not defined (or is empty). The node is kept and drawn as a dashed placeholder. |
| `unknown_edge_type` | error | connection | The connection's type, or the default edge type for a connection without one, is not defined. |
| `unknown_port` | error | connection, node and port | The output or input a connection uses does not exist on its node (a renamed port, a deleted repeater item). |
| `dangling_edge` | error | connection | One or both of the connection's nodes do not exist. Such connections are kept but cannot be drawn; the issues panel lists them. |
| `type_mismatch` | error | connection | With `typeCheck: "strict"`, the input's data type does not accept the output's. |
| `pair_not_allowed` | error | connection | A [pair rule](#pair-rules) refuses the connection. |
| `self_loop` | error | connection and node | A node is connected to itself and `allowSelfLoops` is false. |
| `cycle` | error | connection | `allowCycles` is false and the connection lies on a loop. Each connection on the loop gets one. |
| `multi_edge` | error | connection | `allowMultiEdges` is false and an earlier connection joins the same output and input. |
| `max_connections` | error | node and port | A port has more connections than its `maxConnections`. |
| `edge_type_not_allowed` | error | connection | The connection's type is not in its output's `edgeTypes`. |
| `wrong_direction` | error | connection | The connection runs from an input to an output (its `sourceHandle` names an input, or its `targetHandle` an output). |
| `max_instances` | error | graph, selecting the first extra node | More nodes of a type than its `limits.maxInstances`. |
| `max_nodes` | error | graph | More nodes than `graphRules.maxNodes`. |
| `max_edges` | error | graph | More connections than `graphRules.maxEdges`. |
| `field_required` | error | node or connection, and field | A required field is empty. |
| `min_connections` | warning | node and port | A port has fewer connections than its `minConnections`. |
| `min_instances` | warning | graph | Fewer nodes of a type than its `limits.minInstances`. |
| `min_nodes` | warning | graph | Fewer nodes than `graphRules.minNodes`. |
| `not_connected` | warning | node | `requireConnected` is on and the node has no connection. |
| `unreachable` | warning | node, or graph | `requireReachableFromEntry` is on and the node cannot be reached from an entry node; or the graph has no entry node at all. |
| `deprecated_node_type` | warning | node | The node's type is `deprecated`. |

The completeness checks and deprecation are warnings so that a freshly created or half-built graph can be saved; everything else is an error. A connection with a missing node only raises `dangling_edge`, and the ports and connection rules of a connection to or from a node of an unknown type are not checked (its edge type, required fields and self loop still are). Issues are listed errors first, then warnings, each in the order they were found.

Messages name node titles (or ids), type labels and port labels, and never other field values, because the hook returns them to API clients. Examples:

```text
"Approval": "Approver" is required.
Node x has the type "mystery", which this ruleset does not define.
"Approval" → "End: Approved": output "Escalate" (Event) cannot connect to input "In" (Control flow).
Connection e4 is broken: its target node is missing.
"Request received": output "Next" allows at most 1 connection (has 2).
"End": input "In" needs at least 1 connection (has 0).
The graph has no "Start" node to start from.
```

Every issue also has a fingerprint: a JSON array of the code, the node id, connection id, port and field it points at, and a detail where the ids alone are ambiguous (the port's direction, `type:<key>` for instance limits, the problem text for `invalid_document`). Fingerprints do not depend on message text or positions, so renaming or moving a node does not change them. `max_instances` selects the first extra node but is fingerprinted by type, so deleting any one of the extra nodes never looks like a new error. The `ratchet` policy compares fingerprints to tell errors a graph already had from new ones.

## The stored graph document

The field is a `json` field. Its value is a graph document:

```json
{
	"format": "directus-node-graph",
	"version": 1,
	"nodes": [
		{ "id": "n_k3x9p2qa7hdm", "type": "start", "position": { "x": 0, "y": 0 }, "data": { "title": "Request received" } },
		{ "id": "n_q8w2e5r7t1yu", "type": "task", "position": { "x": 360, "y": 0 }, "data": { "title": "Review contract", "assignee": "security", "due_days": 3 } },
		{ "id": "n_z4x6c8v0b2nm", "type": "end", "position": { "x": 720, "y": 0 }, "data": { "outcome": "approved" } }
	],
	"edges": [
		{ "id": "e_a1s2d3f4g5h6", "type": "flow", "source": "n_k3x9p2qa7hdm", "sourceHandle": "next", "target": "n_q8w2e5r7t1yu", "targetHandle": "in", "data": {} },
		{ "id": "e_j7k8l9m0n1b2", "type": "timeout", "source": "n_q8w2e5r7t1yu", "sourceHandle": "next", "target": "n_z4x6c8v0b2nm", "targetHandle": "in", "data": { "after_hours": 48 } }
	],
	"ruleset": { "key": "approval-workflow", "version": 1 },
	"viewport": { "x": 36, "y": 162, "zoom": 1 },
	"meta": {
		"nodeCount": 3,
		"edgeCount": 2,
		"errorCount": 0,
		"warningCount": 0,
		"counts": { "end": 1, "start": 1, "task": 1 },
		"graphHash": "sha256:37b0029cdfeb1fc3c697e611c51a960a2adcf6f13ecf5572c76add103ba8c561"
	}
}
```

| Key | Notes |
|---|---|
| `format`, `version` | Always `"directus-node-graph"` and `1`. |
| `nodes[]` | `id`, `type` (a node type key), `position` (canvas units at 100% zoom) and `data` (field values by field key). |
| `edges[]` | `id`, `type` (an edge type key; when it is missing the ruleset's default edge type applies), `source` and `target` (node ids), `sourceHandle` (an output key of the source) and `targetHandle` (an input key of the target), and optional `data`. |
| `ruleset` | The `key` and `version` of the ruleset the graph was last saved against. Informational: graphs are always checked against the field's current ruleset. |
| `viewport` | Where the editor was last scrolled and zoomed (`zoom` greater than 0). |
| `meta` | Derived and never trusted on input: the editor recomputes it on Apply and the hook on every write. `counts` has one entry per node type present, keys sorted. `graphHash` is `sha256:` plus the SHA-256 of the canonical JSON of the nodes (id, type, data) and connections (id, type, endpoints, data), each sorted by id; positions, the viewport, `meta` and the ruleset stamp are left out, so moving nodes does not change it. Useful for telling whether two graphs mean the same thing. |

Unknown keys are kept at every level. The editor generates ids as `n_` (nodes) or `e_` (connections) followed by 12 random lowercase letters and digits, but any id works that is a non-empty string of at most 200 characters and not one of the [reserved names](#how-a-ruleset-is-checked). Ids must be unique across nodes and connections.

### Normalisation

Every reader (the field row, the editor, the display and the hook) reads the value through the same normalisation, which never fails:

- `null`, an empty string or a missing value is an empty field. A JSON string is parsed.
- `_user` and `_date` keys, which content versioning stamps onto changed objects, are removed at every depth without comment.
- **Repairs** keep the data and are noted: a missing `format` or `version` marker (when the value has `nodes` or `edges`), numeric ids, types and port keys (turned into text), a missing position (set to 0, 0), a missing type or port key (left empty), a malformed viewport or ruleset stamp (removed). The field row shows a warning tile with the repairs, and the editor's next Apply writes the repaired graph.
- **Fatal problems** lose data and are reported as `invalid_document` errors: a value that is not JSON, not an object, or of another format or version (the whole value reads as an empty graph); `nodes` or `edges` that are not lists; elements that are not objects; nodes without a usable id; connections without a usable id, source or target; types and port keys that are neither text nor numbers; port keys that are reserved names; `data` that is not an object; `__proto__`, `constructor` or `prototype` keys anywhere; values nested more than 64 levels deep.
- Unknown node types, unknown ports, connections to missing nodes and duplicate ids are kept as they are. They are validation issues, not reading problems, so nothing is lost on the next save.

## Server-side enforcement

The bundle's hook validates graph fields whenever items are created or updated through Directus's item service: the app, REST, GraphQL, WebSockets, imports, flows whose operations emit events, revision reverts and version promotion. It checks fields that use the Node Graph interface and are present in the payload, against each field's current ruleset, and applies the field's **Server Enforcement** option:

| Policy | Behaviour |
|---|---|
| `ratchet` (default) | On create, any error refuses the save. On update, an error refuses the save only if one of the updated items did not already have it in its stored value (errors are compared by fingerprint), so graphs with old errors stay editable as long as no new ones are added. An item whose stored value is empty, or that cannot be found, is treated like a create. Stored values are read in chunks of 500 items, and identical values are validated once. |
| `reject` | Any error refuses the save. |
| `log` | Never refuses. Saves with errors or warnings are logged at info level with their counts. |
| `off` | The field is skipped and its value stored as sent. |

For every policy except `off`:

- Warnings never refuse a save, and `null` (clearing the field) is always accepted.
- An accepted value is replaced by the normalised document with a freshly computed `meta` and, when the ruleset compiles, the ruleset stamp.
- A value that could only be read by dropping data (an `invalid_document` problem) is left exactly as sent when the policy accepts it, rather than replaced by the reduced copy.
- A field whose ruleset is missing or does not compile gets only the structural checks (`invalid_document`), and a warning is logged when the hook first reads the field.

A refused save fails with HTTP 400 and the error code `FAILED_VALIDATION`. Its `extensions` are `collection`, `field`, `path` (`[]`), `type` (`"regex"`), `validation_message` and `issues`. `validation_message` lists up to five issues with their codes and ids, for example `The graph has 1 error: "Approval": "Approver" is required. [field_required, node n_k3x9p2qa7hdm]`, or under `ratchet` "This change adds 1 error to the graph: ...". `issues` lists every refusing issue as `{ code, nodeId?, edgeId?, port?, field? }`. The app marks the field as invalid, shows "Value doesn't have the correct format" under it (or the field's own Validation Message, if one is set), and shows `validation_message` in the form's error notice. When two graph fields of one payload fail, both errors are returned.

The hook reads which fields use the Node Graph interface from `directus_fields` and caches the result for 60 seconds. Creating, updating or deleting a field clears the cache on the instance that handled the change; other instances pick it up within the minute. If the lookup fails, the write goes through unchecked and the error is logged, so the hook never blocks collections it does not manage.

### Ruleset check on field save

When a user creates or updates a field that uses the Node Graph interface (in Data Model, through `/fields`, or with `POST /collections` and its `fields`), the hook compiles the field's ruleset. A ruleset that does not compile refuses the save with `INVALID_PAYLOAD` and up to ten of its problems: `The node graph ruleset of "workflow" has 2 problems: ...`. An empty ruleset is allowed; the field then shows a notice until one is set. An update that only changes options is checked against the interface stored for the field.

## What the hook does not see

- **Writes with `emitEvents: false`**, such as flow operations with "Emit Events" off or extensions that call the item service that way.
- **Direct database writes**: SQL, migrations, and extensions that use the database connection directly.
- **Content version drafts.** Saving to a content version writes `directus_versions`, so drafts are not checked. Promoting a version updates the item through the item service, and that update is checked (`api/src/services/versions.ts:342-365` in Directus 11.17.4).
- **System collections.** Their writes emit their own events (`users.update` and so on) rather than `items.*`, so graph fields added to system collections are not enforced.
- **`schema apply`** runs without a user, so the ruleset check on field save is skipped and a snapshot always applies. Graph values are still checked when items are written afterwards.

In the editor, Apply only stages the graph in the item form. Nothing is written, and the hook does not run, until the item is saved; inside a nested drawer the outer drawer must be applied too.
