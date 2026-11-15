/**
 * Comment blanking and style extraction for the text engine. Ported from
 * Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Every function here blanks rather than deletes, so line numbers survive and a
 * finding keeps pointing at the line the author wrote. Prose inside a comment must
 * not be readable as markup, and it must not shift anything either.
 */

/** Extensions that can hold a whole page, where document-level analyzers apply. */
const PAGE_ANALYZER_EXTS: ReadonlySet<string> = new Set([".html", ".htm", ".astro", ".vue", ".svelte"]);

/** Source extensions that hold JavaScript. */
const JS_SOURCE_EXTS: ReadonlySet<string> = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

/** Stylesheet extensions, where `//` comments are legal in the preprocessor dialects only. */
const STYLESHEET_EXTS: ReadonlySet<string> = new Set([".css", ".scss", ".sass", ".less"]);

/** Extensions whose stylesheet blocks and CSS-in-JS templates are extracted for a separate scan. */
const CSS_IN_JS_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".ts", ".jsx", ".tsx"]);

/** Keywords after which a `/` starts a regex rather than a division. */
const REGEX_PREFIX_KEYWORDS: ReadonlySet<string> = new Set([
	"await", "case", "default", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield",
]);

/** Keywords after which a `{` opens a block rather than an object or expression. */
const BLOCK_BRACE_PREFIX_KEYWORDS: ReadonlySet<string> = new Set(["do", "else", "finally", "try"]);

/** The extension of a path, lowercased, or an empty string. */
function extFromFilePath(filePath: string | null | undefined): string {
	return filePath ? (filePath.match(/\.\w+$/)?.[0] || "").toLowerCase() : "";
}

/** True when the cursor sits inside an opening JSX tag that has not closed yet. */
function isInsideOpeningJsxTag(source: string): boolean {
	const tagStart = source.lastIndexOf("<");
	if (tagStart === -1 || !/^<[A-Za-z][\w.:-]*/.test(source.slice(tagStart))) return false;

	let quote = "";
	for (let cursor = tagStart + 1; cursor < source.length; cursor++) {
		const char = source[cursor];
		if (quote) {
			if (char === "\\") cursor++;
			else if (char === quote) quote = "";
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (char === ">") {
			return false;
		}
	}
	return true;
}

export interface JsCommentOptions {
	/** Treat `{` inside JSX as an expression, and `//` in URLs as not a comment. */
	readonly jsx?: boolean;
}

/**
 * Blank JavaScript comments without moving any following source. Regex findings keep
 * their original line numbers, while prose examples inside comments cannot masquerade
 * as rendered markup.
 *
 * This is a state machine, not a regex, because the hard cases are the ones a regex
 * gets wrong: `/` as division or regex, `{` as block or object, `${}` inside a
 * template, and `//` inside a JSX URL.
 */
function stripJsComments(content: string, options: JsCommentOptions = {}): string {
	let state = "code";
	let output = "";
	let lastSignificant = "";
	let previousSignificant = "";
	let antePreviousSignificant = "";
	let currentWord = "";
	let currentWordPrefix = "";
	let wordSeparated = false;
	let regexCharClass = false;
	let jsxExpressionDepth = 0;
	let lastClosedBraceKind = "";
	const braceKinds: string[] = [];
	const templateExpressionDepths: number[] = [];

	const braceKind = (startsJsxExpression = false): string =>
		!startsJsxExpression &&
		(!lastSignificant ||
			lastSignificant === ")" ||
			lastSignificant === ";" ||
			lastSignificant === "}" ||
			(previousSignificant === "=" && lastSignificant === ">") ||
			BLOCK_BRACE_PREFIX_KEYWORDS.has(currentWord))
			? "block"
			: "expression";

	const recordSignificant = (char: string): void => {
		if (/\s/.test(char)) {
			wordSeparated = true;
			return;
		}
		const isWordChar = /[\w$]/.test(char);
		if (isWordChar && (wordSeparated || !currentWord)) {
			currentWord = "";
			currentWordPrefix = lastSignificant;
		} else if (!isWordChar) {
			currentWordPrefix = "";
		}
		wordSeparated = false;
		antePreviousSignificant = previousSignificant;
		previousSignificant = lastSignificant;
		lastSignificant = char;
		currentWord = isWordChar ? currentWord + char : "";
	};

	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		const next = content[i + 1];

		if (state === "line-comment") {
			if (char === "\n") {
				output += char;
				state = "code";
			} else {
				output += " ";
			}
			continue;
		}

		if (state === "block-comment") {
			if (char === "*" && next === "/") {
				output += "  ";
				i++;
				state = "code";
			} else {
				output += char === "\n" ? "\n" : " ";
			}
			continue;
		}

		if (state === "regex") {
			output += char;
			if (char === "\\" && next) {
				output += next;
				i++;
			} else if (char === "[") {
				regexCharClass = true;
			} else if (char === "]") {
				regexCharClass = false;
			} else if (char === "/" && !regexCharClass) {
				state = "code";
				recordSignificant("/");
			}
			continue;
		}

		if (state === "template" && char === "$" && next === "{") {
			output += "${";
			i++;
			recordSignificant("$");
			recordSignificant("{");
			templateExpressionDepths.push(1);
			braceKinds.push("expression");
			if (jsxExpressionDepth) jsxExpressionDepth++;
			state = "code";
			continue;
		}

		if (state !== "code") {
			output += char;
			if (char === "\\" && next) {
				output += next;
				i++;
			} else if (
				(state === "single-quote" && char === "'") ||
				(state === "double-quote" && char === '"') ||
				(state === "template" && char === "`")
			) {
				state = "code";
				recordSignificant(char);
			}
			continue;
		}

		const jsxUrlSeparator =
			options.jsx &&
			char === "/" &&
			next === "/" &&
			jsxExpressionDepth === 0 &&
			(output.endsWith("http:") ||
				output.endsWith("https:") ||
				(/<[A-Za-z](?:[^>]*[^/])?>[^<]*$/.test(output.slice(output.lastIndexOf("\n") + 1)) &&
					/^[\w.-]+\.[A-Za-z]{2,}(?=[:/?#\s<]|$)/.test(content.slice(i + 2))));
		const afterPostfixUpdate =
			(lastSignificant === "+" || lastSignificant === "-") && previousSignificant === lastSignificant && antePreviousSignificant !== lastSignificant;
			const startsRegex =
				!lastSignificant ||
				(/[=([{!?:;,&|+\-*%^~<>]/.test(lastSignificant) && !afterPostfixUpdate) ||
				(lastSignificant === "}" && lastClosedBraceKind === "block") ||
				(previousSignificant === "=" && lastSignificant === ">") ||
				(currentWordPrefix !== "." && REGEX_PREFIX_KEYWORDS.has(currentWord));


		if (char === "/" && next === "/" && jsxUrlSeparator) {
			output += "//";
			i++;
			recordSignificant("/");
			recordSignificant("/");
		} else if (char === "/" && next === "/") {
			output += "  ";
			i++;
			state = "line-comment";
		} else if (char === "/" && next === "*") {
			output += "  ";
			i++;
			state = "block-comment";
		} else if (templateExpressionDepths.length > 0 && char === "{") {
			output += char;
			templateExpressionDepths[templateExpressionDepths.length - 1]++;
			braceKinds.push(braceKind());
			if (jsxExpressionDepth) jsxExpressionDepth++;
			recordSignificant(char);
		} else if (templateExpressionDepths.length > 0 && char === "}") {
			output += char;
			const depthIndex = templateExpressionDepths.length - 1;
			templateExpressionDepths[depthIndex]--;
			lastClosedBraceKind = braceKinds.pop() || "";
			if (jsxExpressionDepth) jsxExpressionDepth--;
			recordSignificant(char);
			if (templateExpressionDepths[depthIndex] === 0) {
				templateExpressionDepths.pop();
				state = "template";
			}
		} else if (char === "/" && startsRegex) {
			output += char;
			state = "regex";
			regexCharClass = false;
		} else {
			output += char;
			const startsJsxExpression =
				!!options.jsx &&
				char === "{" &&
				jsxExpressionDepth === 0 &&
				(/<[A-Za-z](?:[^>]*[^/])?>[^<]*$/.test(output.slice(output.lastIndexOf("\n") + 1, -1)) ||
					isInsideOpeningJsxTag(output.slice(0, -1)));
			if (char === "{") braceKinds.push(braceKind(startsJsxExpression));
			else if (char === "}") lastClosedBraceKind = braceKinds.pop() || "";
			if (char === "{" && (jsxExpressionDepth || startsJsxExpression)) jsxExpressionDepth++;
			else if (char === "}" && jsxExpressionDepth) jsxExpressionDepth--;
			recordSignificant(char);
			if (char === "'") state = "single-quote";
			else if (char === '"') state = "double-quote";
			else if (char === "`") state = "template";
		}
	}

	return output;
}

/** Blank `/* … *\/` comments, keeping newlines so line numbers hold. */
function stripCssComments(content: string): string {
	return content.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Blank `<!-- … -->` comments, keeping newlines. */
function blankHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * Blank `//` comments inside CSS, honoring quotes so a `//` inside a string survives,
 * and tracking `url(...)` so a protocol-relative URL is not read as a comment.
 */
function blankCssLineComments(text: string): string {
	let output = "";
	let state = "code";
	let urlDepth = 0;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		const next = text[i + 1];

		if (state === "line") {
			if (char === "\n") {
				output += "\n";
				state = "code";
			} else {
				output += " ";
			}
			continue;
		}

		if (state === "single" || state === "double") {
			output += char;
			if (char === "\\" && next) {
				output += next;
				i++;
			} else if ((state === "single" && char === "'") || (state === "double" && char === '"')) {
				state = "code";
			}
			continue;
		}

		const prev = output.length > 0 ? output[output.length - 1] : "";
		if (char === "/" && next === "/" && urlDepth === 0 && prev !== ":" && prev !== "(" && prev !== "\\") {
			output += "  ";
			i++;
			state = "line";
			continue;
		}

		if (char === "'") state = "single";
		else if (char === '"') state = "double";

		if (char === "(") {
			const behind = output.replace(/\s+$/, "");
			if (urlDepth > 0 || /url$/i.test(behind)) urlDepth++;
		} else if (char === ")" && urlDepth) {
			urlDepth--;
		}
		output += char;
	}
	return output;
}

/** Blank `//` comments inside `<style>` blocks, leaving everything else byte-identical. */
function blankCssLineCommentsInStyleBlocks(text: string): string {
	const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
	let output = "";
	let lastIndex = 0;

	for (let match = re.exec(text); match !== null; match = re.exec(text)) {
		const inner = match[1];
		const openLength = match[0].length - inner.length - "</style>".length;
		output += text.slice(lastIndex, match.index);
		output += match[0].slice(0, openLength);
		output += blankCssLineComments(inner);
		output += match[0].slice(openLength + inner.length);
		lastIndex = re.lastIndex;
	}
	return output + text.slice(lastIndex);
}

/** HTML comments and CSS comments everywhere except inside `<script>` blocks. */
function blankHtmlAndCssCommentsOutsideScripts(text: string): string {
	const re = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
	let output = "";
	let lastIndex = 0;

	for (let match = re.exec(text); match !== null; match = re.exec(text)) {
		output += blankCssLineCommentsInStyleBlocks(stripCssComments(blankHtmlComments(text.slice(lastIndex, match.index))));
		output += match[0];
		lastIndex = re.lastIndex;
	}
	return output + blankCssLineCommentsInStyleBlocks(stripCssComments(blankHtmlComments(text.slice(lastIndex))));
}

/** The index of the closing `'`/`"` of a string, or -1. */
function findQuotedStringEnd(content: string, start: number, quote: string): number {
	for (let cursor = start + 1; cursor < content.length; cursor++) {
		if (content[cursor] === "\\") cursor++;
		else if (content[cursor] === quote) return cursor;
	}
	return -1;
}

/** The index of the closing `/` of a regex literal, or -1. */
function findRegexLiteralEnd(content: string, start: number): number {
	let inCharacterClass = false;
	for (let cursor = start + 1; cursor < content.length; cursor++) {
		const char = content[cursor];
		if (char === "\\") {
			cursor++;
		} else if (char === "[") {
			inCharacterClass = true;
		} else if (char === "]") {
			inCharacterClass = false;
		} else if (char === "/" && !inCharacterClass) {
			while (/[A-Za-z]/.test(content[cursor + 1] || "")) cursor++;
			return cursor;
		} else if (char === "\n" || char === "\r") {
			return -1;
		}
	}
	return -1;
}

/** The index of the `}` closing a template `${…}` expression, or -1. */
function findTemplateExpressionEnd(content: string, start: number): number {
	let depth = 1;
	let lastSignificant = "";
	let previousSignificant = "";
	let antePreviousSignificant = "";
	let currentWord = "";
	let currentWordPrefix = "";
	let wordSeparated = false;
	let lastClosedBraceKind = "";
	const braceKinds: string[] = [];

	const braceKind = (): string =>
		lastSignificant === ")" ||
		lastSignificant === ";" ||
		lastSignificant === "}" ||
		(previousSignificant === "=" && lastSignificant === ">") ||
		BLOCK_BRACE_PREFIX_KEYWORDS.has(currentWord)
			? "block"
			: "expression";

	const recordSignificant = (char: string): void => {
		if (/\s/.test(char)) {
			wordSeparated = true;
			return;
		}
		const isWordChar = /[\w$]/.test(char);
		if (isWordChar && (wordSeparated || !currentWord)) {
			currentWord = "";
			currentWordPrefix = lastSignificant;
		} else if (!isWordChar) {
			currentWordPrefix = "";
		}
		wordSeparated = false;
		antePreviousSignificant = previousSignificant;
		previousSignificant = lastSignificant;
		lastSignificant = char;
		currentWord = isWordChar ? currentWord + char : "";
	};

	for (let cursor = start; cursor < content.length; cursor++) {
		const char = content[cursor];
		const next = content[cursor + 1];
		const afterPostfixUpdate =
			(lastSignificant === "+" || lastSignificant === "-") && previousSignificant === lastSignificant && antePreviousSignificant !== lastSignificant;
			const startsRegex =
				!lastSignificant ||
				(/[=([{!?:;,&|+\-*%^~<>]/.test(lastSignificant) && !afterPostfixUpdate) ||
				(lastSignificant === "}" && lastClosedBraceKind === "block") ||
				(previousSignificant === "=" && lastSignificant === ">") ||
				(currentWordPrefix !== "." && REGEX_PREFIX_KEYWORDS.has(currentWord));


		if (char === "'" || char === '"') {
			cursor = findQuotedStringEnd(content, cursor, char);
			if (cursor === -1) return -1;
			recordSignificant(")");
		} else if (char === "/" && next === "/") {
			const lineEnd = content.indexOf("\n", cursor + 2);
			if (lineEnd === -1) return -1;
			cursor = lineEnd;
		} else if (char === "/" && next === "*") {
			const commentEnd = content.indexOf("*/", cursor + 2);
			if (commentEnd === -1) return -1;
			cursor = commentEnd + 1;
		} else if (char === "/" && startsRegex) {
			cursor = findRegexLiteralEnd(content, cursor);
			if (cursor === -1) return -1;
			recordSignificant(")");
		} else if (char === "`") {
			cursor = findTemplateLiteralEnd(content, cursor);
			if (cursor === -1) return -1;
			recordSignificant(")");
		} else if (char === "{") {
			depth++;
			braceKinds.push(braceKind());
			recordSignificant(char);
		} else if (char === "}") {
			depth--;
			if (depth === 0) return cursor;
			lastClosedBraceKind = braceKinds.pop() || "";
			recordSignificant(char);
		} else {
			recordSignificant(char);
		}
	}
	return -1;
}

/** The index of the closing backtick of a template literal, or -1. */
function findTemplateLiteralEnd(content: string, start: number): number {
	for (let cursor = start + 1; cursor < content.length; cursor++) {
		const char = content[cursor];
		if (char === "\\") {
			cursor++;
		} else if (char === "`") {
			return cursor;
		} else if (char === "$" && content[cursor + 1] === "{") {
			cursor = findTemplateExpressionEnd(content, cursor + 2);
			if (cursor === -1) return -1;
		}
	}
	return -1;
}

/**
 * The index of the line that closes an Astro frontmatter block, or -1. Astro opens a
 * file with `---` and closes it on a line that starts with `---`, which is why the
 * scan has to skip over strings, templates, comments, and regexes on the way.
 */
function findAstroFrontmatterClose(text: string): number {
	if (!text.startsWith("---")) return -1;
	let cursor = text.indexOf("\n");
	if (cursor === -1) return -1;
	cursor += 1;

	while (cursor < text.length) {
		if (text[cursor - 1] === "\n" && text.startsWith("---", cursor)) {
			let end = cursor + 3;
			while (text[end] === " " || text[end] === "\t") end++;
			if (end >= text.length || text[end] === "\n" || text[end] === "\r") return cursor - 1;
		}

		const char = text[cursor];
		const next = text[cursor + 1];
		if (char === "'" || char === '"') {
			const close = findQuotedStringEnd(text, cursor, char);
			if (close === -1) return -1;
			cursor = close + 1;
			continue;
		}
		if (char === "`") {
			const close = findTemplateLiteralEnd(text, cursor);
			if (close === -1) return -1;
			cursor = close + 1;
			continue;
		}
		if (char === "/" && next === "/") {
			const lineEnd = text.indexOf("\n", cursor);
			if (lineEnd === -1) return -1;
			cursor = lineEnd;
			continue;
		}
		if (char === "/" && next === "*") {
			const commentEnd = text.indexOf("*/", cursor + 2);
			if (commentEnd === -1) return -1;
			cursor = commentEnd + 2;
			continue;
		}
		if (char === "/" && next !== "/" && next !== "*") {
			const close = findRegexLiteralEnd(text, cursor);
			if (close !== -1) {
				cursor = close + 1;
				continue;
			}
		}
		cursor++;
	}
	return -1;
}

/** Blank comments inside an Astro frontmatter block, leaving the rest untouched. */
function blankAstroFrontmatterComments(text: string): string {
	const close = findAstroFrontmatterClose(text);
	if (close === -1) return text;
	return stripJsComments(text.slice(0, close)) + text.slice(close);
}

/**
 * Blank every comment form the matchers must not read, chosen by extension: page
 * formats get HTML and CSS comments, stylesheets get CSS and preprocessor comments,
 * and anything else is left as-is for the JavaScript pass to handle.
 */
function blankCommentsForMatchers(text: string, ext: string): string {
	if (PAGE_ANALYZER_EXTS.has(ext)) {
		const withFrontmatter = ext === ".astro" ? blankAstroFrontmatterComments(text) : text;
		return blankHtmlAndCssCommentsOutsideScripts(withFrontmatter);
	}
	if (STYLESHEET_EXTS.has(ext)) {
		const withoutBlocks = stripCssComments(text);
		return ext === ".css" ? withoutBlocks : blankCssLineComments(withoutBlocks);
	}
	return text;
}

/** A `<style>` block extracted for a separate stylesheet scan, with its starting line. */
export interface StyleBlock {
	readonly content: string;
	readonly startLine: number;
}

/** The `<style>` blocks of a component format, with the line each block starts on. */
function extractStyleBlocks(content: string, ext: string): StyleBlock[] {
	const normalized = ext.toLowerCase();
	if (normalized !== ".astro" && normalized !== ".vue" && normalized !== ".svelte") return [];

	const blocks: StyleBlock[] = [];
	const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		const before = content.substring(0, m.index);
		const startLine = before.split("\n").length + 1;
		blocks.push({ content: m[1], startLine });
	}
	return blocks;
}

/** A CSS-in-JS template literal found in a source file. */
interface CssInJsTemplate {
	readonly tagStart: number;
	readonly contentStart: number;
	readonly contentEnd: number;
}

/**
 * `styled.x`/`styled(X)`/`css` templates, including the `styled(X).attr` form with a
 * generic argument before the template.
 */
function findCssInJsTemplates(content: string): CssInJsTemplate[] {
	const templates: CssInJsTemplate[] = [];
	const tagRe = /\b(?:styled(?:\.\w+|\([^)]+\))|css)/g;

	for (let match = tagRe.exec(content); match !== null; match = tagRe.exec(content)) {
		let cursor = match.index + match[0].length;
		while (/\s/.test(content[cursor] || "")) cursor++;

		if (content[cursor] === "<") {
			let depth = 0;
			while (cursor < content.length) {
				const char = content[cursor];
				if (char === "<") depth++;
				else if (char === ">" && content[cursor - 1] !== "=") depth--;
				cursor++;
				if (depth === 0) break;
			}
			if (depth !== 0) continue;
			while (/\s/.test(content[cursor] || "")) cursor++;
		}

		if (content[cursor] !== "`") continue;
		const contentStart = cursor + 1;
		cursor = findTemplateLiteralEnd(content, cursor);
		if (cursor === -1) continue;

		templates.push({ tagStart: match.index, contentStart, contentEnd: cursor });
		tagRe.lastIndex = cursor + 1;
	}
	return templates;
}

/** The CSS-in-JS templates of a source file, with the line each starts on. */
function extractCssInJs(content: string, ext: string): StyleBlock[] {
	const normalized = ext.toLowerCase();
	if (!CSS_IN_JS_EXTENSIONS.has(normalized)) return [];

	return findCssInJsTemplates(content).map((template) => {
		const before = content.substring(0, template.tagStart);
		const startLine = before.split("\n").length;
		return { content: content.slice(template.contentStart, template.contentEnd), startLine };
	});
}

/** Blank CSS comments inside CSS-in-JS templates, leaving the surrounding code alone. */
function stripCssInJsComments(content: string, ext: string): string {
	if (!CSS_IN_JS_EXTENSIONS.has(ext.toLowerCase())) return content;

	const templates = findCssInJsTemplates(content);
	let output = "";
	let cursor = 0;
	for (const template of templates) {
		output += content.slice(cursor, template.contentStart);
		output += stripCssComments(content.slice(template.contentStart, template.contentEnd));
		cursor = template.contentEnd;
	}
	return output + content.slice(cursor);
}

export {
	BLOCK_BRACE_PREFIX_KEYWORDS,
	blankAstroFrontmatterComments,
	blankCommentsForMatchers,
	blankCssLineComments,
	blankHtmlAndCssCommentsOutsideScripts,
	blankHtmlComments,
	CSS_IN_JS_EXTENSIONS,
	extractCssInJs,
	extractStyleBlocks,
	extFromFilePath,
	findAstroFrontmatterClose,
	findCssInJsTemplates,
	findQuotedStringEnd,
	findRegexLiteralEnd,
	findTemplateExpressionEnd,
	findTemplateLiteralEnd,
	isInsideOpeningJsxTag,
	JS_SOURCE_EXTS,
	PAGE_ANALYZER_EXTS,
	REGEX_PREFIX_KEYWORDS,
	STYLESHEET_EXTS,
	stripCssComments,
	stripCssInJsComments,
	stripJsComments,
};
export type { CssInJsTemplate };
