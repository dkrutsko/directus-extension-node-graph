<script setup lang="ts">
/**
 * "Load Example": a small secondary button with the stock menu of examples
 * (v-menu with a v-list, as the stock layouts' option menus are).
 */

import { RULESET_EXAMPLES, type RulesetExample } from './examples';

defineEmits<{
	choose: [example: RulesetExample];
}>();

const ICONS: Record<string, string> = {
	'approval-workflow': 'how_to_reg',
	'simple-approval': 'task_alt',
	blank: 'note_add',
};
</script>

<template>
	<v-menu show-arrow placement="bottom-start">
		<template #activator="{ toggle }">
			<v-button small secondary class="ng-options-load" @click="toggle">
				<v-icon name="library_add" left small />
				Load Example
				<v-icon name="expand_more" right small />
			</v-button>
		</template>

		<!-- The menu is teleported to the menu outlet, so it carries its own style root (options-editor.css). -->
		<div class="node-graph-options-menu">
			<v-list>
				<v-list-item v-for="example in RULESET_EXAMPLES" :key="example.id" clickable @click="$emit('choose', example)">
					<v-list-item-icon><v-icon :name="ICONS[example.id] ?? 'description'" /></v-list-item-icon>
					<v-list-item-content>
						<div class="ng-options-example">
							<span class="ng-options-example__name">{{ example.name }}</span>
							<span class="ng-options-example__description">{{ example.description }}</span>
						</div>
					</v-list-item-content>
				</v-list-item>
			</v-list>
		</div>
	</v-menu>
</template>
