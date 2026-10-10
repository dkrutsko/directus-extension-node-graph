/**
 * Keyboard helpers for the editor shell.
 *
 * Extensions cannot use the app's `useShortcut` / `translateShortcut`
 * (`@directus/composables` is not one of the shared dependencies, and the
 * SDK does not re-export them: directus-11.17.4/packages/extensions-sdk/src/index.ts:1-11),
 * so the bits the editor needs are reproduced here.
 */

/**
 * Same platform test as Directus's translateShortcut
 * (directus-11.17.4/packages/composables/src/translate-shortcut.ts:4), so the
 * editor's tooltips show the same symbols as the drawer's own X ("Cancel (Esc)").
 */
export function isApplePlatform(): boolean {
	if (typeof navigator === 'undefined') return false;

	const platform = navigator.platform ?? '';
	return platform.toLowerCase().startsWith('mac') || platform.startsWith('iP');
}

/**
 * A shortcut as Directus writes it in tooltips: `⌘⇧Z` on Apple platforms,
 * `Ctrl+Shift+Z` elsewhere (translate-shortcut.ts:3-25). Keys use the
 * Directus names: `meta` (Command or Control), `shift`, `alt`, `enter`, `esc`.
 */
export function shortcutLabel(keys: string[]): string {
	if (isApplePlatform()) {
		return keys
			.map((key) => {
				if (key === 'meta') return '⌘';
				if (key === 'shift') return '⇧';
				if (key === 'alt' || key === 'option') return '⌥';
				if (key === 'enter') return '⏎';
				return capitalize(key);
			})
			.join('');
	}

	return keys
		.map((key) => {
			if (key === 'meta') return 'Ctrl';
			if (key === 'enter') return '↵';
			return capitalize(key);
		})
		.join('+');
}

/**
 * Directus treats Control and Command as the same modifier (`keyMap` in
 * directus-11.17.4/packages/composables/src/use-shortcut.ts:6-9), so ⌘S and
 * Ctrl+S both save an item on every platform. The editor follows suit.
 */
export function hasModifier(event: KeyboardEvent): boolean {
	return event.metaKey || event.ctrlKey;
}

/**
 * True when a key press belongs to a text control: inputs, textareas,
 * selects and contenteditable elements keep their native Backspace, Delete
 * and undo behaviour.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;

	const tag = target.tagName;

	if (tag === 'TEXTAREA' || tag === 'SELECT') return true;

	if (tag === 'INPUT') {
		const type = (target as HTMLInputElement).type;
		// Checkboxes, radios and buttons have no text to edit.
		return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
	}

	return false;
}

/**
 * True while a Directus `v-menu` is open (a select dropdown in the inspector,
 * for example). Menus close themselves on Escape through `useShortcut` on
 * `document.body` (directus-11.17.4/app/src/components/v-menu.vue:126-131),
 * so the editor must let that Escape through instead of consuming it.
 * Menus teleport into `#menu-outlet` (app/index.html:28-31, v-menu.vue:478).
 */
export function isMenuOpen(): boolean {
	if (typeof document === 'undefined') return false;
	return document.querySelector('#menu-outlet .v-menu-popper.active') !== null;
}

function capitalize(key: string): string {
	return key.length === 0 ? key : key.charAt(0).toUpperCase() + key.slice(1);
}
