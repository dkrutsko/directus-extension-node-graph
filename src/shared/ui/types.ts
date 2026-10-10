/**
 * Types shared by the shell components. Kept out of the SFCs so other
 * modules can import them without importing a component.
 */

import type { GraphDocument } from '../core';

/** What clicking the field row does; null makes the row inert (empty and read-only). */
export type FieldRowAction = 'edit' | 'view' | 'create';

/** What the editor loads when it opens. The interface creates a new one for every open. */
export interface EditorSession {
	document: GraphDocument;
	/** valueSignature() of the field value the session started from. */
	source: string;
	/** Opened through "Create": Apply must emit even if nothing was changed. */
	created: boolean;
	/** The stored value had to be repaired: Apply must emit the repaired document. */
	repaired: boolean;
}
