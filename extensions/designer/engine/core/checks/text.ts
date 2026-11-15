/**
 * Text helpers shared by the rules, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 */

// Emoji render as multicolor glyphs regardless of CSS `color`, so a contrast
// check against the element's text color is meaningless for these nodes.
const EMOJI_CHAR_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/u;
const EMOJI_CHARS_GLOBAL = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;

/** True when the text is only emoji, whitespace, and variation selectors. */
function isEmojiOnlyText(text: string | null | undefined): boolean {
	if (!text) return false;
	if (!EMOJI_CHAR_RE.test(text)) return false;
	return text.replace(EMOJI_CHARS_GLOBAL, "").trim() === "";
}

export { isEmojiOnlyText };
