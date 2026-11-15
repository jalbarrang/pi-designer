/**
 * DESIGN.md parsed into a structured model: frontmatter tokens plus the prose scraped from the
 * eight canonical sections. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Deterministic and dependency-free. Two layers on purpose: the frontmatter is
 * machine-readable, and the prose is what a human wrote. When both carry a value, consumers
 * can prefer the frontmatter and fall back to the prose.
 *
 * The extraction is heuristic, and each pattern is tolerant of the two shapes that show up in
 * practice: the "**Name** (value): description" bullet form and the Stitch "**Name (value):**"
 * form. Anything it cannot read becomes null rather than a guess.
 */

/** The eight sections a design record is organized into, in order. */
const CANONICAL_SECTIONS: readonly string[] = [
	"Overview",
	"Colors",
	"Typography",
	"Layout",
	"Elevation",
	"Shapes",
	"Components",
	"Do's and Don'ts",
];

// ─── Frontmatter ───────────────────────────────────────────────────────────

function parseFrontmatter(md: string): { frontmatter: Record<string, unknown> | null; body: string } {
	const lines = md.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { frontmatter: null, body: md };

	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return { frontmatter: null, body: md };

	const yaml = lines.slice(1, end).join("\n");
	const body = lines.slice(end + 1).join("\n");
	try {
		return { frontmatter: parseYamlSubset(yaml), body };
	} catch {
		return { frontmatter: null, body: md };
	}
}

/**
 * A minimal YAML reader for the frontmatter subset: scalar maps with one level of nested
 * objects. No arrays, anchors, or multi-line scalars — the schema does not need them, and
 * accepting them would mean vendoring a real YAML parser.
 */
function parseYamlSubset(yaml: string): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }];

	for (const raw of yaml.split(/\r?\n/)) {
		// Blank lines and line-only comments are skipped. Inline comments are not stripped
		// here: an unquoted hex value starts with `#` and cannot be safely told apart from a
		// comment after whitespace.
		if (!raw.trim() || /^\s*#/.test(raw)) continue;

		const indent = raw.match(/^\s*/)?.[0].length ?? 0;
		const content = raw.slice(indent);
		const colonIdx = findTopLevelColon(content);
		if (colonIdx === -1) continue;

		while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();

		const key = unquoteYamlKey(content.slice(0, colonIdx).trim());
		const rest = stripInlineYamlComment(content.slice(colonIdx + 1).trim());
		const parent = stack[stack.length - 1].obj;

		if (rest === "") {
			const obj: Record<string, unknown> = {};
			parent[key] = obj;
			stack.push({ indent, obj });
		} else {
			parent[key] = parseScalar(rest);
		}
	}

	return root;
}

function findTopLevelColon(s: string): number {
	let inQuote: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inQuote) {
			if (ch === inQuote && s[i - 1] !== "\\") inQuote = null;
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === ":") {
			return i;
		}
	}
	return -1;
}

function unquoteYamlKey(key: string): string {
	if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) return key.slice(1, -1);
	return key;
}

function stripInlineYamlComment(s: string): string {
	let inQuote: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inQuote) {
			if (ch === inQuote && s[i - 1] !== "\\") inQuote = null;
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === "#" && i > 0 && /\s/.test(s[i - 1])) {
			return s.slice(0, i).trimEnd();
		}
	}
	return s;
}

// YAML double-quoted scalars process backslash escapes; stripping the quotes without
// unescaping leaves them in place, so a nested font family like
//   fontFamily: "\"IBM Plex Sans\", system-ui, sans-serif"
// keeps literal backslashes and never matches the same family in CSS. Full YAML 1.2 set.
const YAML_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	"0": "\0",
	a: "\x07",
	b: "\b",
	t: "\t",
	n: "\n",
	v: "\v",
	f: "\f",
	r: "\r",
	e: "\x1b",
	" ": " ",
	'"': '"',
	"/": "/",
	"\\": "\\",
	N: "\u0085",
	_: "\u00a0",
	L: "\u2028",
	P: "\u2029",
};
const YAML_HEX_ESCAPE_LENGTHS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

function unescapeYamlDoubleQuoted(body: string): string {
	let out = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch !== "\\" || i === body.length - 1) {
			out += ch;
			continue;
		}
		const next = body[i + 1];
		if (Object.prototype.hasOwnProperty.call(YAML_SIMPLE_ESCAPES, next)) {
			out += YAML_SIMPLE_ESCAPES[next];
			i++;
			continue;
		}
		// \xNN, \uNNNN, \UNNNNNNNN. A malformed or out-of-range sequence stays literal rather
		// than corrupting the rest of the scalar.
		const hexLen = YAML_HEX_ESCAPE_LENGTHS[next];
		if (hexLen) {
			const hex = body.slice(i + 2, i + 2 + hexLen);
			const codePoint = hex.length === hexLen && /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : -1;
			if (codePoint >= 0 && codePoint <= 0x10ffff) {
				out += String.fromCodePoint(codePoint);
				i += 1 + hexLen;
				continue;
			}
		}
		out += ch;
	}
	return out;
}

function parseScalar(raw: string): unknown {
	const s = raw.trim();
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return unescapeYamlDoubleQuoted(s.slice(1, -1));
	// Single-quoted YAML escapes only the quote itself, by doubling it.
	if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).split("''").join("'");
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "null" || s === "~") return null;
	if (/^-?\d+$/.test(s)) return Number(s);
	if (/^-?\d*\.\d+$/.test(s)) return Number(s);
	return s;
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const OKLCH_RE = /oklch\([^)]+\)/gi;

// ─── Sections ──────────────────────────────────────────────────────────────

interface Section {
	readonly name: string;
	readonly subtitle: string | null;
	readonly lines: string[];
}

function splitSections(md: string): { title: string | null; sections: Record<string, Section> } {
	const lines = md.split(/\r?\n/);
	let title: string | null = null;
	const sections: Record<string, Section> = {};
	let current: Section | null = null;

	for (const raw of lines) {
		const line = raw.trimEnd();

		if (!title && line.startsWith("# ") && !line.startsWith("## ")) {
			title = line.replace(/^#\s+/, "").trim();
			continue;
		}

		const h2 = line.match(/^##\s+(?:\d+\.\s*)?([^:\n]+?)(?::\s*(.+))?$/);
		if (h2) {
			const rawName = normalizeApostrophes(h2[1].trim());
			const subtitle = h2[2] ? h2[2].trim() : null;
			const canonical = matchCanonicalSection(rawName);
			if (canonical) {
				current = { name: canonical, subtitle, lines: [] };
				sections[canonical] = current;
				continue;
			}
			// A non-canonical H2 is ignored, and it stops feeding the previous section.
			current = null;
			continue;
		}

		if (current) current.lines.push(raw);
	}

	return { title, sections };
}

function normalizeApostrophes(s: string): string {
	return s.replace(/[\u2018\u2019]/g, "'");
}

function matchCanonicalSection(name: string): string | null {
	const normalized = normalizeApostrophes(name).toLowerCase();

	for (const canonical of CANONICAL_SECTIONS) {
		if (normalizeApostrophes(canonical).toLowerCase() === normalized) return canonical;
	}

	// Keyword-contained: "Overview & Creative North Star" is Overview, "Elevation & Depth" is
	// Elevation. Order is precedence, which is why the list is ordered.
	for (const canonical of CANONICAL_SECTIONS) {
		const key = normalizeApostrophes(canonical).toLowerCase();
		const pattern = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
		if (pattern.test(normalized)) return canonical;
	}
	return null;
}

interface Subsection {
	name: string | null;
	lines: string[];
}

function splitSubsections(lines: readonly string[]): Subsection[] {
	const subs: Subsection[] = [];
	let current: Subsection = { name: null, lines: [] };
	subs.push(current);

	for (const raw of lines) {
		const h3 = raw.match(/^###\s+(.+?)\s*$/);
		if (h3) {
			current = { name: h3[1].trim(), lines: [] };
			subs.push(current);
			continue;
		}
		current.lines.push(raw);
	}

	return subs;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function collectParagraphs(lines: readonly string[]): string[] {
	const paragraphs: string[] = [];
	let buf: string[] = [];

	const flush = () => {
		if (buf.length > 0) {
			paragraphs.push(buf.join(" ").trim());
			buf = [];
		}
	};

	for (const raw of lines) {
		const trimmed = raw.trim();
		// A blank line, horizontal rule, heading, or bullet ends a paragraph.
		if (trimmed === "") {
			flush();
			continue;
		}
		if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			flush();
			continue;
		}
		if (raw.startsWith("#") || raw.match(/^[-*]\s/)) {
			flush();
			continue;
		}
		buf.push(trimmed);
	}
	flush();
	return paragraphs.filter(Boolean);
}

function collectBullets(lines: readonly string[]): string[] {
	const bullets: string[] = [];
	let current: string | null = null;

	for (const raw of lines) {
		const m = raw.match(/^\s*[-*]\s+(.+)$/);
		if (m) {
			if (current) bullets.push(current);
			current = m[1];
			continue;
		}
		// An indented line continues the bullet it sits under.
		if (current && raw.match(/^\s{2,}\S/)) {
			current += ` ${raw.trim()}`;
			continue;
		}
		if (raw.trim() === "" && current) {
			bullets.push(current);
			current = null;
		}
	}
	if (current) bullets.push(current);
	return bullets;
}

function stripBold(s: string): string {
	return s.replace(/\*\*(.+?)\*\*/g, "$1");
}

/** One of the record's named rules: a "The X Rule" heading or bullet, with its body. */
export interface NamedRule {
	readonly name: string;
	readonly body: string;
}

/**
 * The record's named rules, in the three shapes they are written in:
 *
 * - inline: `**The X Rule.** body` (can span lines)
 * - heading: `### The "X" Rule` with the body beneath
 * - bullet: `* **The X Principle:** body`
 *
 * The inline shape keeps repeats visible; the other two dedupe by name, which is what the
 * original behavior did.
 */
function extractNamedRules(lines: readonly string[]): NamedRule[] {
	const rules: NamedRule[] = [];
	const seen = new Set<string>();

	const addRule = (name: string, body: string, { allowDuplicate = false }: { readonly allowDuplicate?: boolean } = {}) => {
		const key = name.toLowerCase();
		if (!allowDuplicate && seen.has(key)) return;
		seen.add(key);
		rules.push({ name, body });
	};

	const joined = lines.join("\n");
	const inlineMatches = [...joined.matchAll(/\*\*(The [^*]+?Rule)\.\*\*/g)];
	for (let i = 0; i < inlineMatches.length; i++) {
		const match = inlineMatches[i];
		const bodyEnd = inlineMatches[i + 1]?.index ?? joined.length;
		const body = joined
			.slice(match.index + match[0].length, bodyEnd)
			.replace(/\n##[^\n]*$/s, "")
			.replace(/\n###[^\n]*$/s, "")
			.trim();
		addRule(stripBold(match[1]).trim(), stripBold(body), { allowDuplicate: true });
	}

	for (const subsection of splitSubsections(lines).slice(1)) {
		const headerName = stripBold(subsection.name ?? "")
			.replace(/["“”]/g, "")
			.trim();
		if (!/^The\b.*\b(Rule|Fallback|Principle)\b/i.test(headerName)) continue;

		const body = stripBold(subsection.lines.join("\n").replace(/\n+/g, " ")).trim();
		if (body) addRule(headerName, body);
	}

	for (const bullet of collectBullets(lines)) {
		const mm = bullet.match(/^\*\*([^*]+?)\*\*\s*(.+)$/);
		if (!mm) continue;
		const nameRaw = mm[1]
			.replace(/[.:]\s*$/, "")
			.replace(/["“”]/g, "")
			.trim();
		if (!/^The\b.+\b(Rule|Fallback|Principle)$/i.test(nameRaw)) continue;
		addRule(nameRaw, stripBold(mm[2]).trim());
	}

	return rules;
}

// ─── Per-section extractors ────────────────────────────────────────────────

export interface DesignOverview {
	readonly subtitle: string | null;
	readonly creativeNorthStar: string | null;
	readonly philosophy: readonly string[];
	readonly keyCharacteristics: readonly string[];
}

function extractOverview(section: Section | undefined): DesignOverview | null {
	if (!section) return null;
	const text = section.lines.join("\n");

	const northStar = text.match(/\*\*Creative North Star:\s*"([^"]+)"\*\*/);
	const keyCharMatch = text.match(/\*\*Key Characteristics:\*\*\s*\n([\s\S]+?)(?:\n##|\n###|$)/);
	const keyChars = keyCharMatch ? collectBullets(keyCharMatch[1].split("\n")).map((bullet) => stripBold(bullet.trim())) : [];
	const prose = keyCharMatch ? text.slice(0, keyCharMatch.index) + text.slice((keyCharMatch.index ?? 0) + keyCharMatch[0].length) : text;

	const philosophy = collectParagraphs(prose.split("\n")).filter(
		(p) => !p.startsWith("**Creative North Star") && !p.startsWith("**Key Characteristics"),
	);

	return {
		subtitle: section.subtitle,
		creativeNorthStar: northStar ? northStar[1] : null,
		philosophy,
		keyCharacteristics: keyChars,
	};
}

/** One documented color. */
export interface DesignColor {
	readonly name: string | null;
	readonly value: string;
	readonly valueRange: readonly string[] | null;
	readonly format: string;
	readonly description: string | null;
}

/** A group of colors under one role. */
export interface DesignColorGroup {
	readonly role: string | null;
	readonly colors: readonly DesignColor[];
}

export interface DesignColors {
	readonly subtitle: string | null;
	readonly description: string | null;
	readonly groups: readonly DesignColorGroup[];
	readonly rules: readonly NamedRule[];
}

function extractColors(section: Section | undefined): DesignColors | null {
	if (!section) return null;
	const subs = splitSubsections(section.lines);
	const description = collectParagraphs(subs[0].lines).join(" ");
	const groups: Array<{ role: string | null; colors: DesignColor[] }> = [];
	const ROLE_KEYWORDS = /^(primary|secondary|tertiary|neutral|accent)\b/i;

	for (const sub of subs.slice(1)) {
		if (!sub.name || /Named Rules?/i.test(sub.name) || /^The\s/i.test(sub.name)) continue;

		const parsed = collectBullets(sub.lines)
			.map((bullet) => parseColorBullet(bullet))
			.filter((color): color is DesignColor => !!color);
		if (parsed.length === 0) continue;

		// When every bullet opens with a role keyword, each becomes its own group; otherwise
		// the subsection is the group.
		const allRoleBullets = parsed.every((color) => color.name && ROLE_KEYWORDS.test(color.name));
		if (allRoleBullets) {
			for (const color of parsed) groups.push({ role: color.name, colors: [color] });
		} else {
			groups.push({ role: sub.name, colors: parsed });
		}
	}

	// A Colors section with no subsections falls back to a flat bullet list.
	if (groups.length === 0) {
		const flat = collectBullets(section.lines)
			.map((bullet) => parseColorBullet(bullet))
			.filter((color): color is DesignColor => !!color);
		for (const color of flat) {
			if (color.name && ROLE_KEYWORDS.test(color.name)) {
				groups.push({ role: color.name, colors: [color] });
				continue;
			}
			const palette = groups.find((group) => group.role === "Palette");
			if (palette) palette.colors.push(color);
			else groups.push({ role: "Palette", colors: [color] });
		}
	}

	return {
		subtitle: section.subtitle,
		description: description || null,
		groups,
		rules: extractNamedRules(section.lines),
	};
}

function parseColorBullet(bullet: string): DesignColor | null {
	const text = bullet.trim();

	// `**Name** (value-with-maybe-nested-parens): description`
	const bold = text.match(/^\*\*(.+?)\*\*\s*(.*)$/);
	if (bold && bold[2].startsWith("(")) {
		const value = extractParenGroup(bold[2]);
		if (value !== null) {
			const after = bold[2].slice(value.length + 2).trimStart();
			if (after.startsWith(":")) return buildColor(bold[1], value, after.slice(1).trim());
		}
	}

	// `**Name (values):** description` — the value is embedded in the bold run.
	const stitch = text.match(/^\*\*([^*]+?)\s*\(([^)]+)\):\*\*\s*(.*)$/);
	if (stitch) return buildColor(stitch[1].trim(), stitch[2], stitch[3]);

	// A plain bullet whose hex/oklch values are the only content.
	const values = collectColorValues(text);
	if (values.length > 0) return buildColor(null, values.join(" to "), text);
	return null;
}

/** The content of a balanced parenthesized group at the start of the string, or null. */
function extractParenGroup(s: string): string | null {
	if (s[0] !== "(") return null;
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "(") depth++;
		else if (s[i] === ")") {
			depth--;
			if (depth === 0) return s.slice(1, i);
		}
	}
	return null;
}

function buildColor(name: string | null, rawValue: string, description: string): DesignColor {
	const values = collectColorValues(rawValue);
	const primary = values[0] ?? rawValue.trim();
	return {
		name: name ? stripBold(name).trim() : null,
		value: primary,
		valueRange: values.length > 1 ? values : null,
		format: detectFormat(primary),
		description: stripBold(description || "").trim() || null,
	};
}

function collectColorValues(s: string): string[] {
	const out: string[] = [];
	s.replace(HEX_RE, (v) => {
		out.push(v);
		return v;
	});
	s.replace(OKLCH_RE, (v) => {
		out.push(v);
		return v;
	});
	return out;
}

function detectFormat(v: string | null | undefined): string {
	if (!v) return "unknown";
	if (v.startsWith("#")) return "hex";
	if (/^oklch/i.test(v)) return "oklch";
	if (/^rgb/i.test(v)) return "rgb";
	return "unknown";
}

/** One font role. */
export interface DesignFont {
	readonly family: string;
	readonly fallback: string | null;
	readonly purpose?: string;
}

export interface DesignTypeEntry {
	readonly name: string;
	readonly specs: readonly string[];
	readonly purpose: string | null;
}

export interface DesignTypography {
	readonly subtitle: string | null;
	readonly fonts: Record<string, DesignFont>;
	readonly character: string | null;
	readonly hierarchy: readonly DesignTypeEntry[];
	readonly rules: readonly NamedRule[];
}

function extractTypography(section: Section | undefined): DesignTypography | null {
	if (!section) return null;
	const text = section.lines.join("\n");
	const fonts: Record<string, DesignFont> = {};

	// `**Display Font:** Family (with fallback)`
	const fontLineRe = /\*\*([\w\s/]+?)Font:\*\*\s*([^\n(]+?)(?:\s*\(with\s+([^)]+)\))?\s*$/gm;
	for (let fm = fontLineRe.exec(text); fm !== null; fm = fontLineRe.exec(text)) {
		const rawRole = fm[1].trim().toLowerCase().replace(/\s+/g, "-");
		const role = normalizeFontRole(rawRole) || "display";
		fonts[role] = { family: fm[2].trim(), fallback: fm[3] ? fm[3].trim() : null };
	}

	// `**Display & Headlines (Noto Serif):** description`
	if (Object.keys(fonts).length === 0) {
		const stitchRe = /\*\*([\w\s&/]+?)\s*\(([^)]+)\):\*\*\s*(.+)/g;
		for (let sm = stitchRe.exec(text); sm !== null; sm = stitchRe.exec(text)) {
			const rawRole = sm[1]
				.trim()
				.toLowerCase()
				.replace(/\s*&\s*/g, "-")
				.replace(/\s+/g, "-");
			const role = normalizeFontRole(rawRole) || rawRole;
			fonts[role] = { family: sm[2].trim(), fallback: null, purpose: sm[3].trim() };
		}
	}

	// The character paragraph is either labelled or the first free paragraph.
	const characterMatch = text.match(/\*\*Character:\*\*\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\n|\n###|\n##|$)/);
	let character = characterMatch ? characterMatch[1].replace(/\n/g, " ").trim() : null;
	if (!character) {
		const paragraphs = collectParagraphs(section.lines).filter((p) => !/^\*\*[\w\s/&]+Font/i.test(p) && !/^\*\*[\w\s/&]+\([^)]+\)/.test(p));
		if (paragraphs.length > 0) character = paragraphs[0];
	}

	const hierarchySub = splitSubsections(section.lines).find((sub) => sub.name && /hierarch/i.test(sub.name));
	const hierarchy = hierarchySub
		? collectBullets(hierarchySub.lines)
				.map((bullet) => parseTypeBullet(bullet))
				.filter((entry): entry is DesignTypeEntry => !!entry)
		: [];

	return { subtitle: section.subtitle, fonts, character, hierarchy, rules: extractNamedRules(section.lines) };
}

/**
 * The canonical role a font is declared for. Compound roles like `display-&-headlines` or
 * `ui-&-body` collapse to the first canonical role they name.
 */
function normalizeFontRole(raw: string): string | null {
	const tokens = raw.split(/[-/&\s]+/).filter(Boolean);
	const priority = ["display", "headline", "body", "ui", "label", "mono"];
	const canonical: Record<string, string> = { headline: "display", ui: "body" };
	for (const p of priority) {
		if (tokens.includes(p)) return canonical[p] || p;
	}
	return null;
}

function parseTypeBullet(bullet: string): DesignTypeEntry | null {
	// `- **Display** (family, weight 300, clamp(...), line-height 1): purpose`
	const m = bullet.match(/^\*\*(.+?)\*\*\s*\(([^)]+)\):\s*(.*)$/);
	if (!m) return null;
	return {
		name: m[1].trim(),
		specs: m[2].split(",").map((s) => s.trim()),
		purpose: stripBold(m[3] || "").trim() || null,
	};
}

export interface DesignGuidance {
	readonly subtitle: string | null;
	readonly description: string | null;
	readonly rules: readonly NamedRule[];
}

function extractGuidance(section: Section | undefined): DesignGuidance | null {
	if (!section) return null;
	const subs = splitSubsections(section.lines);
	return {
		subtitle: section.subtitle,
		description: collectParagraphs(subs[0].lines).join(" ") || null,
		rules: extractNamedRules(section.lines),
	};
}

export interface DesignShadow {
	readonly name: string | null;
	readonly value: string;
	readonly purpose: string | null;
}

export interface DesignElevation extends DesignGuidance {
	readonly shadows: readonly DesignShadow[];
}

function extractElevation(section: Section | undefined): DesignElevation | null {
	const guidance = extractGuidance(section);
	if (!guidance || !section) return null;

	const shadows: DesignShadow[] = [];
	const seen = new Set<string>();
	const dedupe = (entry: DesignShadow) => {
		const key = `${entry.name || ""}::${entry.value}`;
		if (seen.has(key)) return;
		seen.add(key);
		shadows.push(entry);
	};

	for (const bullet of collectBullets(section.lines)) {
		const parsed = parseShadowBullet(bullet);
		if (parsed) dedupe(parsed);
	}

	// Shadows are also written inline in prose, so both paragraphs and bullets are scanned.
	for (const paragraph of collectParagraphs(section.lines)) {
		for (const inline of extractInlineShadows(paragraph)) dedupe(inline);
	}
	for (const bullet of collectBullets(section.lines)) {
		for (const inline of extractInlineShadows(bullet)) dedupe(inline);
	}

	return { ...guidance, shadows };
}

/** `box-shadow: …` anywhere in prose, with a name taken from the noun before it. */
function extractInlineShadows(text: string): DesignShadow[] {
	const out: DesignShadow[] = [];
	const re = /box-shadow\s*:\s*([^`;\n]+)/gi;

	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		const value = m[1].replace(/[`.)]+$/, "").trim();
		if (!value) continue;

		// The name is the noun immediately before the shadow phrase: "an extra-diffused
		// shadow: …" becomes "Extra-diffused shadow".
		const before = text.slice(0, m.index);
		const nameMatch = before.match(/\b([A-Za-z][A-Za-z\- ]{2,40})\s+shadow\b[^A-Za-z0-9]*$/i);
		let name: string | null = null;
		if (nameMatch) {
			const stripped = nameMatch[1]
				.replace(/^(?:use|using|apply|applying|is|are|looks? like)\s+/i, "")
				.replace(/^(?:a|an|the)\s+/i, "")
				.trim();
			if (stripped) name = `${stripped.charAt(0).toUpperCase()}${stripped.slice(1)} shadow`;
		}
		out.push({ name, value, purpose: null });
	}
	return out;
}

/**
 * `**Name** (\`box-shadow: value\`): purpose` or `**Name** (\`value\`): purpose`. The paren
 * content has to look like a shadow, which is what filters out `**Rule Name:**` bullets.
 */
function parseShadowBullet(bullet: string): DesignShadow | null {
	const m = bullet.match(/^\*\*(.+?)\*\*\s*\(`?([^`]+?)`?\):\s*(.*)$/);
	if (!m) return null;

	const rawValue = m[2].replace(/^box-shadow:\s*/i, "").trim();
	const looksLikeShadow = /box-shadow|rgba?\(|\bpx\b|\brem\b|^-?\d+\s/i.test(rawValue) && /\d/.test(rawValue);
	if (!looksLikeShadow) return null;

	return { name: stripBold(m[1]).trim(), value: rawValue, purpose: stripBold(m[3] || "").trim() || null };
}

export interface DesignVariant {
	readonly name: string;
	readonly description: string;
}

export interface DesignComponent {
	readonly name: string;
	readonly description: string | null;
	readonly properties: Record<string, string>;
	readonly variants: readonly DesignVariant[];
}

export interface DesignComponents {
	readonly subtitle: string | null;
	readonly components: readonly DesignComponent[];
}

function extractComponents(section: Section | undefined): DesignComponents | null {
	if (!section) return null;
	const components: DesignComponent[] = [];

	for (const sub of splitSubsections(section.lines).slice(1)) {
		if (!sub.name) continue;

		const variants: DesignVariant[] = [];
		const properties: Record<string, string> = {};

		for (const bullet of collectBullets(sub.lines)) {
			const m = bullet.match(/^\*\*(.+?):?\*\*:?\s*(.+)$/);
			if (!m) continue;
			const key = stripBold(m[1]).trim();
			const value = stripBold(m[2]).trim();

			// A variant is a state or emphasis ("Primary", "Hover"); anything else is a
			// property ("Shape", "Background").
			if (/^(primary|secondary|tertiary|ghost|hover|focus|active|disabled|default|error|selected|unselected|state)$/i.test(key.split(/[\s/]/)[0])) {
				variants.push({ name: key, description: value });
			} else {
				properties[key.toLowerCase()] = value;
			}
		}

		components.push({ name: sub.name, description: collectParagraphs(sub.lines).join(" ") || null, properties, variants });
	}

	return { subtitle: section.subtitle, components };
}

export interface DesignDosDonts {
	readonly dos: readonly string[];
	readonly donts: readonly string[];
}

function extractDosDonts(section: Section | undefined): DesignDosDonts | null {
	if (!section) return null;
	const dos: string[] = [];
	const donts: string[] = [];

	for (const sub of splitSubsections(section.lines).slice(1)) {
		if (!sub.name) continue;
		const subName = normalizeApostrophes(sub.name);
		const bullets = collectBullets(sub.lines).map((bullet) => stripBold(bullet).trim());

		if (/^do'?t?:?$/i.test(subName) || /^do:?$/i.test(subName)) dos.push(...bullets);
		else if (/^don'?t:?$/i.test(subName)) donts.push(...bullets);
	}

	// Loose bullets outside an H3 are classified by their prefix instead.
	for (const bullet of collectBullets(section.lines)) {
		const stripped = normalizeApostrophes(stripBold(bullet).trim());
		if (/^don'?t\b/i.test(stripped)) {
			if (!donts.some((d) => normalizeApostrophes(d) === stripped)) donts.push(stripped);
		} else if (/^do\b/i.test(stripped)) {
			if (!dos.some((d) => normalizeApostrophes(d) === stripped)) dos.push(stripped);
		}
	}

	return { dos, donts };
}

// ─── The model ─────────────────────────────────────────────────────────────

/** Everything the parser reads out of a design record. A null section is absent, not empty. */
export interface DesignModel {
	readonly schemaVersion: number;
	readonly title: string | null;
	readonly frontmatter: Record<string, unknown> | null;
	readonly overview: DesignOverview | null;
	readonly colors: DesignColors | null;
	readonly typography: DesignTypography | null;
	readonly layout: DesignGuidance | null;
	readonly elevation: DesignElevation | null;
	readonly shapes: DesignGuidance | null;
	readonly components: DesignComponents | null;
	readonly dosDonts: DesignDosDonts | null;
}

/** What each section actually carries, for a staleness or coverage report. */
export type CoverageEntry = Record<string, unknown> | "missing";

/** Description-plus-rules models share one coverage shape. */
function guidanceCoverage(guidance: DesignGuidance | null): CoverageEntry {
	return guidance ? { description: Boolean(guidance.description), rules: guidance.rules.length } : "missing";
}

/** How complete the model is, section by section. */
function assessCoverage(model: DesignModel): Record<string, CoverageEntry> {
	const report: Record<string, CoverageEntry> = {};

	report.overview = model.overview
		? {
				northStar: Boolean(model.overview.creativeNorthStar),
				philosophy: model.overview.philosophy.length > 0,
				keyCharacteristics: model.overview.keyCharacteristics.length,
			}
		: "missing";

	report.colors = model.colors
		? {
				groups: model.colors.groups.length,
				totalColors: model.colors.groups.reduce((n, group) => n + group.colors.length, 0),
				rules: model.colors.rules.length,
			}
		: "missing";

	report.typography = model.typography
		? {
				fonts: Object.keys(model.typography.fonts).length,
				hierarchyEntries: model.typography.hierarchy.length,
				character: Boolean(model.typography.character),
				rules: model.typography.rules.length,
			}
		: "missing";

	report.layout = guidanceCoverage(model.layout);

	report.elevation = model.elevation
		? { shadows: model.elevation.shadows.length, rules: model.elevation.rules.length, description: Boolean(model.elevation.description) }
		: "missing";

	report.shapes = guidanceCoverage(model.shapes);

	report.components = model.components
		? {
				count: model.components.components.length,
				variantTotal: model.components.components.reduce((n, component) => n + component.variants.length, 0),
			}
		: "missing";

	report.dosDonts = model.dosDonts ? { dos: model.dosDonts.dos.length, donts: model.dosDonts.donts.length } : "missing";

	return report;
}

/** Parse a design record into the model. */
function parseDesignMd(md: string): DesignModel {
	const { frontmatter, body } = parseFrontmatter(md);
	const { title, sections } = splitSections(body);

	return {
		schemaVersion: 2,
		title,
		frontmatter,
		overview: extractOverview(sections.Overview),
		colors: extractColors(sections.Colors),
		typography: extractTypography(sections.Typography),
		layout: extractGuidance(sections.Layout),
		elevation: extractElevation(sections.Elevation),
		shapes: extractGuidance(sections.Shapes),
		components: extractComponents(sections.Components),
		dosDonts: extractDosDonts(sections["Do's and Don'ts"]),
	};
}

export { assessCoverage, CANONICAL_SECTIONS, matchCanonicalSection, parseDesignMd, splitSections };
export type { Section };
