/**
 * Directus's own translations, where a key matches the text exactly.
 *
 * The app installs vue-i18n 11 in composition mode with global injection
 * (directus-11.17.4/app/src/lang/index.ts:8-17), so `$t` lives on the app's
 * `globalProperties` and is reachable from any component an extension
 * renders. Reading it there, instead of declaring `$t` on
 * ComponentCustomProperties, keeps the shared code free of a global type
 * augmentation that could clash with a package that installs vue-i18n's own
 * typings.
 *
 * Only keys that exist in directus-11.17.4/app/src/lang/translations/en-US.yaml
 * with exactly the wanted English text are used; everything else is plain
 * English (Directus has no keys for undo, redo, zoom or graph wording).
 * Each call passes that English text as the fallback, so the editor still
 * reads correctly if a key goes missing in a later release.
 */

import { getCurrentInstance } from 'vue';

export type Translate = (key: string, fallback: string) => string;

export function useAppText(): Translate {
	const instance = getCurrentInstance();
	const candidate = instance?.appContext.config.globalProperties['$t'];
	const translate = typeof candidate === 'function' ? (candidate as (key: string) => unknown) : null;

	return (key, fallback) => {
		if (!translate) return fallback;

		// Called during render, so the locale ref inside vue-i18n is tracked
		// and a language switch re-renders the editor.
		const result = translate(key);
		return typeof result === 'string' && result !== '' && result !== key ? result : fallback;
	};
}
