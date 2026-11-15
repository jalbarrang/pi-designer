/**
 * Page shape helpers, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 */

/** True when the content is a whole page (doctype, `<html>`, or `<head>`) rather than a component or partial. */
function isFullPage(content: string): boolean {
	const stripped = content.replace(/<!--[\s\S]*?-->/g, "");
	return /<!doctype\s|<html[\s>]|<head[\s>]/i.test(stripped);
}

export { isFullPage };
