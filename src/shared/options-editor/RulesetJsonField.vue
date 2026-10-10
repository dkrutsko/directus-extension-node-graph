<script setup lang="ts">
/**
 * The ruleset as JSON text: the stock code editor (`interface-input-code`,
 * the global component of the input-code interface) with the live result of
 * the text above it. Used by the JSON drawer and, when the form cannot show
 * the stored ruleset, inline in its place.
 */

import { computed } from 'vue';
import { inspectJson } from './json-draft';

const props = defineProps<{
	modelValue: string;
	label: string;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: string];
}>();

const draft = computed(() => inspectJson(props.modelValue));

const MAX_LISTED = 30;

/*
 * Plain text mode with JSON highlighting and linting: without `type: 'json'`
 * the editor emits the text as typed (input-code.vue:68-95), so invalid JSON
 * stays editable here instead of being dropped.
 */
function onInput(value: unknown) {
	emit('update:modelValue', typeof value === 'string' ? value : '');
}
</script>

<template>
	<div class="ng-json-field">
		<!-- Notices stack closely, like the options' status notices; the editor follows at the form's row gap. -->
		<div class="ng-json-field__notices">
			<slot name="notices" />

			<v-notice v-if="draft.state === 'empty'" type="info">Empty. Applying removes the ruleset; the field then shows a notice instead of the editor.</v-notice>

			<v-notice v-else-if="draft.state === 'invalid'" type="danger" multiline indent-content class="ng-options-notice">
				<template #title>This text cannot be applied</template>
				<div class="ng-options-notice__content">
					<ul class="ng-options-problems">
						<li v-for="(problem, index) in draft.problems" :key="index">{{ problem }}</li>
					</ul>
				</div>
			</v-notice>

			<v-notice v-else-if="draft.problems.length > 0" type="warning" multiline indent-content class="ng-options-notice">
				<template #title>{{ draft.problems.length }} {{ draft.problems.length === 1 ? 'problem' : 'problems' }}</template>
				<div class="ng-options-notice__content">
					<ul class="ng-options-problems">
						<li v-for="(problem, index) in draft.problems.slice(0, MAX_LISTED)" :key="index">{{ problem }}</li>
						<li v-if="draft.problems.length > MAX_LISTED">…and {{ draft.problems.length - MAX_LISTED }} more.</li>
					</ul>
					<p>It can be applied and fixed afterwards, but saving the field is refused until the problems are fixed.</p>
				</div>
			</v-notice>

			<v-notice v-else type="success">Valid ruleset.</v-notice>

			<v-notice v-if="draft.formReasons.length > 0" type="warning" multiline indent-content class="ng-options-notice">
				<template #title>Values the form cannot show</template>
				<div class="ng-options-notice__content">
					<ul class="ng-options-problems">
						<li v-for="(reason, index) in draft.formReasons.slice(0, MAX_LISTED)" :key="index">{{ reason }}</li>
					</ul>
					<p>It can still be applied and edited as JSON.</p>
				</div>
			</v-notice>
		</div>

		<div class="ng-json-field__editor">
			<p class="type-label">{{ label }}</p>
			<interface-input-code :value="modelValue" language="JSON" line-number line-wrapping placeholder="{ }" @input="onInput" />
			<small class="type-note">
				The whole ruleset, in the format of the ruleset reference (docs/ruleset.md). Paste an example or a ruleset copied from another field.
			</small>
		</div>
	</div>
</template>

<style scoped>
/* One column that never grows past the drawer: long lines wrap in the code editor instead. */
.ng-json-field {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--theme--form--row-gap);
}

.ng-json-field__notices {
	display: flex;
	flex-direction: column;
	gap: 0.6875rem;
}

.ng-json-field__editor {
	min-inline-size: 0;
}

.ng-json-field__editor .type-label {
	margin-block-end: 0.4375rem;
}

/* The field note of form-field.vue:307-312 */
.ng-json-field__editor .type-note {
	position: relative;
	display: block;
	max-inline-size: 29.25rem;
	margin-block-start: 0.25rem;
}
</style>
