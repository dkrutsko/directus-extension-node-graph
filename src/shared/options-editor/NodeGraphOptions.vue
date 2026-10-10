<script setup lang="ts">
/**
 * The interface options of the node-graph field, in Data Model → field →
 * Interface. Directus mounts it as `interface-options-node-graph` because the
 * interface's `options` is a component (isVueComponent,
 * directus-11.17.4/app/src/modules/settings/routes/data-model/field-detail/shared/extension-options.vue:35-40
 * and 91-102; registered in app/src/interfaces/index.ts:14-22), with the
 * whole options object as `value`, plus `collection` and `field`. It emits
 * `input` with the new options object, which replaces the stored one
 * (field-detail-advanced-interface.vue:88-100, store/index.ts:200-203). It
 * gets no `disabled` prop and no raw-editor toggle.
 *
 * Layout, top to bottom, all stock components:
 *
 * - the plain options (summary template, placeholder, width, enforcement,
 *   grid) in a v-form, as extension-options.vue renders an options array;
 * - the ruleset actions: Load Example (with a confirmation before replacing
 *   a ruleset) and Edit as JSON (a drawer with the code editor);
 * - the result of compiling the stored ruleset: valid, or the problems that
 *   make the hook refuse to save the field (guard.ts `guardField`);
 * - the ruleset as a v-form of group-detail sections with Repeaters
 *   (form-fields.ts), or, when the stored ruleset has a shape the form cannot
 *   show, the JSON editor in its place.
 *
 * The stored `ruleset` option stays one Ruleset object in the documented
 * format. The form works on a view model read from it (view-model.ts) and
 * writes the rebuilt ruleset back on every change. The view model is state
 * of this component: it is read again only when the stored ruleset changes
 * from outside (first mount, Load Example, the JSON editor), so rows the
 * ruleset cannot store yet (a severity override without a code) stay in the
 * form while the admin works on them.
 *
 * Nothing is emitted on mount, and nothing is emitted when a change rebuilds
 * the ruleset that is already stored: opening the field settings never marks
 * them as edited (store/index.ts `fieldUpdates`).
 */

import { useStores } from '@directus/extensions-sdk';
import { computed, ref, shallowRef, toRaw, watch } from 'vue';
import { compileRuleset } from '../core/compile';
import { hasOwn, isPlainObject } from '../core/util';
import { generalOptionFields } from '../options';
import { useAppText } from '../ui/i18n';
import ExampleMenu from './ExampleMenu.vue';
import type { RulesetExample } from './examples';
import { collectChoices, rulesetFormFields } from './form-fields';
import { inspectJson, rulesetText } from './json-draft';
import RulesetJsonField from './RulesetJsonField.vue';
import { fromViewModel, sameText, toViewModel, viewModelNotes, type RulesetViewModel } from './view-model';
import './options-editor.css';

type Obj = Record<string, unknown>;

const props = withDefaults(
	defineProps<{
		value?: Obj | null;
		collection?: string | null;
		field?: string | null;
	}>(),
	{
		value: null,
		collection: null,
		field: null,
	},
);

const emit = defineEmits<{
	input: [value: Obj];
}>();

const t = useAppText();
const { useNotificationsStore } = useStores();
const notifications = useNotificationsStore();

const MAX_LISTED = 30;

/* Stored options ---------------------------------------------------------- */

const options = computed<Obj>(() => {
	const value = toRaw(props.value);
	return isPlainObject(value) ? value : {};
});

const storedRuleset = computed(() => toRaw(options.value['ruleset']));

function isBlankRuleset(value: unknown): boolean {
	return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** The stored ruleset as an object, or null: the text form parsed, for comparisons. */
function parsedStored(): unknown {
	const stored = storedRuleset.value;
	if (typeof stored !== 'string') return stored ?? null;

	try {
		return JSON.parse(stored);
	} catch {
		return stored;
	}
}

/* View model -------------------------------------------------------------- */

const vm = shallowRef<RulesetViewModel>({});
const base = shallowRef<Obj | null>(null);
const fromText = ref(false);

/** The form cannot show the stored ruleset (toViewModel refused it); the JSON editor takes its place. */
const unreadable = ref(false);
const fallbackDraft = ref('');

/** The ruleset value this component wrote last. Its echo through the store is not a change from outside. */
let written: { value: unknown } | null = null;

function load(raw: unknown) {
	const result = toViewModel(raw);

	if (result.ok) {
		vm.value = result.vm;
		base.value = result.base;
		fromText.value = result.fromText;
		unreadable.value = false;
	} else {
		vm.value = {};
		base.value = null;
		fromText.value = false;
		unreadable.value = true;
		fallbackDraft.value = result.text;
	}
}

watch(
	storedRuleset,
	(raw) => {
		if (written && sameText(raw, written.value)) return;
		load(raw);
	},
	{ immediate: true },
);

/* Writing ----------------------------------------------------------------- */

/** Replaces (or, with undefined, removes) the `ruleset` option, keeping every other option and the key order. */
function writeRuleset(ruleset: Obj | undefined) {
	const current = options.value;
	const next: Obj = {};

	if (ruleset !== undefined && !hasOwn(current, 'ruleset')) next['ruleset'] = ruleset;

	for (const key of Object.keys(current)) {
		if (key !== 'ruleset') next[key] = current[key];
		else if (ruleset !== undefined) next['ruleset'] = ruleset;
	}

	written = { value: ruleset };
	emit('input', next);
}

/** A whole new ruleset (an example, the JSON editor): read it into the form and store it as given. */
function replaceRuleset(ruleset: Obj | undefined) {
	load(ruleset);
	writeRuleset(ruleset);
}

function onRulesetForm(value: unknown) {
	const next = (isPlainObject(value) ? value : {}) as RulesetViewModel;
	vm.value = next;

	const rebuilt = fromViewModel(next, base.value);

	if (Object.keys(rebuilt).length === 0) {
		// An empty form means no ruleset, not `{}`: an empty object does not compile and would block saving the field.
		if (!isBlankRuleset(storedRuleset.value)) writeRuleset(undefined);
		return;
	}

	// Interfaces may echo a value without a change; only a different ruleset is an edit.
	if (sameText(rebuilt, parsedStored())) return;

	writeRuleset(rebuilt);
}

const generalValues = computed<Obj>(() => {
	const { ruleset: _ruleset, ...rest } = options.value;
	return rest;
});

/**
 * The plain options form emits all its values (v-form `setValue`), without
 * the ones reset to their default (v-form `unsetValue`), like the stock
 * options form. The ruleset is put back as stored, text or object.
 */
function onGeneralForm(value: unknown) {
	const edits = isPlainObject(value) ? value : {};
	const current = options.value;
	const next: Obj = {};

	for (const key of Object.keys(current)) {
		if (key === 'ruleset') next[key] = current[key];
		else if (hasOwn(edits, key)) next[key] = edits[key];
	}

	for (const key of Object.keys(edits)) {
		if (key !== 'ruleset' && !hasOwn(next, key)) next[key] = edits[key];
	}

	if (sameText(next, current)) return;
	emit('input', next);
}

/* Status ------------------------------------------------------------------ */

const compiled = computed(() => (isBlankRuleset(storedRuleset.value) ? null : compileRuleset(storedRuleset.value)));

const summary = computed(() => {
	const ruleset = compiled.value?.ruleset;
	if (!ruleset) return '';

	const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

	// A ruleset without edge types gets the built-in "default" one (compile.ts IMPLICIT_EDGE_TYPE), which is not counted as declared.
	const stored = parsedStored();
	const declared = isPlainObject(stored) && Array.isArray(stored['edgeTypes']) ? stored['edgeTypes'].length : 0;

	return [
		count(ruleset.nodeTypes.length, 'node type', 'node types'),
		declared === 0 ? 'the built-in edge type' : count(declared, 'edge type', 'edge types'),
		count(ruleset.dataTypes.length, 'data type', 'data types'),
	].join(', ');
});

const notes = computed(() => viewModelNotes(vm.value));

const choices = computed(() => collectChoices(vm.value));
const rulesetFields = computed(() => rulesetFormFields(choices.value));

/* Load example ------------------------------------------------------------ */

const pendingExample = shallowRef<RulesetExample | null>(null);

const confirmExample = computed({
	get: () => pendingExample.value !== null,
	set: (open: boolean) => {
		if (!open) pendingExample.value = null;
	},
});

function chooseExample(example: RulesetExample) {
	if (isBlankRuleset(storedRuleset.value)) loadExample(example);
	else pendingExample.value = example;
}

function loadExample(example: RulesetExample) {
	pendingExample.value = null;
	replaceRuleset(example.create());
}

/* JSON editor ------------------------------------------------------------- */

const jsonOpen = ref(false);
const jsonDraft = ref('');
const jsonInitial = ref('');
const confirmDiscardJson = ref(false);

const jsonStatus = computed(() => inspectJson(jsonDraft.value));
const fallbackStatus = computed(() => inspectJson(fallbackDraft.value));

function openJson() {
	jsonInitial.value = rulesetText(storedRuleset.value);
	jsonDraft.value = jsonInitial.value;
	jsonOpen.value = true;
}

function applyText(status: ReturnType<typeof inspectJson>): boolean {
	if (status.state === 'invalid') return false;
	replaceRuleset(status.state === 'ok' && status.value ? status.value : undefined);
	return true;
}

function applyJson() {
	if (applyText(jsonStatus.value)) jsonOpen.value = false;
}

function cancelJson() {
	if (jsonDraft.value !== jsonInitial.value) confirmDiscardJson.value = true;
	else jsonOpen.value = false;
}

function discardJson() {
	confirmDiscardJson.value = false;
	jsonOpen.value = false;
}

function applyFallback() {
	applyText(fallbackStatus.value);
}

async function copyJson() {
	try {
		await navigator.clipboard.writeText(jsonDraft.value);
		notifications.add({ title: t('copy_raw_value_success', 'Copied') });
	} catch {
		notifications.add({ title: t('copy_raw_value_fail', 'Copy Failed'), type: 'error' });
	}
}

/** Saves the editor's text as `<ruleset key>.json`, the way the examples are kept. */
function downloadJson() {
	const key = jsonStatus.value.value?.['key'];
	const name = `${typeof key === 'string' && /^[A-Za-z0-9_-]+$/.test(key) ? key : 'ruleset'}.json`;
	const text = jsonDraft.value.endsWith('\n') ? jsonDraft.value : `${jsonDraft.value}\n`;
	const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.click();
	URL.revokeObjectURL(url);
}
</script>

<template>
	<div class="node-graph-options">
		<v-form class="ng-options-general" :fields="generalOptionFields" :model-value="generalValues" primary-key="+" @update:model-value="onGeneralForm" />

		<div v-if="unreadable" class="ng-options-head">
			<ruleset-json-field v-model="fallbackDraft" label="Ruleset">
				<!-- What is wrong with the text is listed by the field itself, live, as it is edited. -->
				<template #notices>
					<v-notice type="info" multiline indent-content class="ng-options-notice ng-options-fallback">
						<template #title>Opened as JSON</template>
						<div class="ng-options-notice__content">
							<p>
								The form cannot show this ruleset, and nothing was changed. Fix it below and apply it; the form opens once every value has the shape
								the ruleset reference describes.
							</p>
						</div>
					</v-notice>
				</template>
			</ruleset-json-field>

			<div class="ng-options-actions">
				<v-button small :disabled="fallbackStatus.state === 'invalid'" @click="applyFallback">
					<v-icon name="check" left small />
					{{ t('apply', 'Apply') }}
				</v-button>
				<example-menu @choose="chooseExample" />
			</div>
		</div>

		<template v-else>
			<div class="ng-options-head">
				<v-notice v-if="!compiled" type="info" class="ng-options-status">
					No ruleset yet. Load an example or fill in the sections below. Until then the field shows a notice instead of the editor.
				</v-notice>

				<v-notice v-else-if="compiled.problems.length > 0" type="danger" multiline indent-content class="ng-options-notice ng-options-status">
					<template #title>The ruleset has {{ compiled.problems.length }} {{ compiled.problems.length === 1 ? 'problem' : 'problems' }}</template>
					<div class="ng-options-notice__content">
						<ul class="ng-options-problems">
							<li v-for="(problem, index) in compiled.problems.slice(0, MAX_LISTED)" :key="index">{{ problem }}</li>
							<li v-if="compiled.problems.length > MAX_LISTED">…and {{ compiled.problems.length - MAX_LISTED }} more.</li>
						</ul>
						<p>Saving the field is refused until they are fixed.</p>
					</div>
				</v-notice>

				<v-notice v-else type="success" class="ng-options-status">Valid ruleset: {{ summary }}.</v-notice>

				<v-notice v-if="notes.length > 0" type="warning" multiline indent-content class="ng-options-notice">
					<template #title>Not saved as entered</template>
					<div class="ng-options-notice__content">
						<ul class="ng-options-problems ng-options-problems--text">
							<li v-for="(note, index) in notes" :key="index">{{ note }}</li>
						</ul>
					</div>
				</v-notice>

				<v-notice v-if="fromText" type="info">This ruleset is stored as JSON text. Your first change here stores it as an object; both mean the same.</v-notice>

				<div class="ng-options-actions">
					<example-menu @choose="chooseExample" />

					<v-button small secondary class="ng-options-json" @click="openJson">
						<v-icon name="data_object" left small />
						Edit as JSON
					</v-button>
				</div>
			</div>

			<v-form class="ng-options-ruleset" :fields="rulesetFields" :model-value="vm" primary-key="+" @update:model-value="onRulesetForm" />
		</template>

		<v-dialog v-model="confirmExample" @esc="pendingExample = null" @apply="pendingExample && loadExample(pendingExample)">
			<v-card>
				<v-card-title>Replace the Ruleset?</v-card-title>
				<v-card-text>
					Loading "{{ pendingExample?.name }}" replaces the current ruleset. Nothing is saved until you save the field, and Cancel in the field settings keeps the stored one.
				</v-card-text>
				<v-card-actions>
					<v-button secondary @click="pendingExample = null">{{ t('cancel', 'Cancel') }}</v-button>
					<v-button @click="pendingExample && loadExample(pendingExample)">Replace</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<v-drawer v-model="jsonOpen" title="Ruleset as JSON" icon="data_object" persistent @cancel="cancelJson" @apply="applyJson">
			<template #actions>
				<v-button v-tooltip.bottom="t('copy', 'Copy')" :aria-label="t('copy', 'Copy')" icon rounded secondary small @click="copyJson">
					<v-icon name="content_copy" small />
				</v-button>
				<v-button v-tooltip.bottom="'Download'" aria-label="Download" icon rounded secondary small @click="downloadJson">
					<v-icon name="download" small />
				</v-button>
				<v-button
					v-tooltip.bottom="t('apply', 'Apply')"
					:aria-label="t('apply', 'Apply')"
					icon
					rounded
					small
					:disabled="jsonStatus.state === 'invalid'"
					@click="applyJson"
				>
					<v-icon name="check" small />
				</v-button>
			</template>

			<div class="node-graph-options-json">
				<ruleset-json-field v-model="jsonDraft" label="Ruleset" />
			</div>

			<v-dialog v-model="confirmDiscardJson" @esc="confirmDiscardJson = false" @apply="discardJson">
				<v-card>
					<v-card-title>{{ t('unsaved_changes', 'Unsaved Changes') }}</v-card-title>
					<v-card-text>{{ t('unsaved_changes_copy', 'Are you sure you want to leave this page?') }}</v-card-text>
					<v-card-actions>
						<v-button secondary @click="discardJson">{{ t('discard_changes', 'Discard Changes') }}</v-button>
						<v-button @click="confirmDiscardJson = false">{{ t('keep_editing', 'Keep Editing') }}</v-button>
					</v-card-actions>
				</v-card>
			</v-dialog>
		</v-drawer>
	</div>
</template>
