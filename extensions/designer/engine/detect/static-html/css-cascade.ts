/**
 * The static CSS cascade: how a file's stylesheets become a computed style per element,
 * with no browser. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The upstream version leans on a third-party HTML parser and css-tree. Here both arrive
 * as `DomModules`, because pi's static scan may be given a parser by its host, and the
 * engine should not pick one. What stays ours is the part that matters: specificity,
 * declaration expansion, inheritance, custom properties, the hover pass, and the two
 * pseudo-element shapes the contrast and eyebrow checks need.
 */
import fs from "node:fs";
import path from "node:path";
import { parseAnyColor, type Color } from "../../core/shared/color.ts";
import type { CssStyle } from "../../dom.ts";
import { collectCssCustomProps, resolveVarRefs } from "../../core/checks/css-scan.ts";
import { cssLengthToPx } from "../../core/checks/css-rules.ts";
import {
	cssPropToCamel,
	expandStaticBoxValues,
	extractStaticColor,
	normalizeStaticCssValue,
	parseStaticAnimation,
	parseStaticBorder,
	parseStaticFont,
	parseStaticTransition,
	splitCssList,
	splitCssTokens,
	STATIC_DEFAULT_STYLE,
	STATIC_INHERITED_PROPS,
} from "./css-values.ts";

// ─── Shapes the host supplies ──────────────────────────────────────────────

/** A parsed HTML node, in the shape htmlparser2 produces (which is what upstream used). */
export interface HtmlNode {
	readonly type: string;
	readonly name?: string;
	readonly data?: string;
	readonly attribs?: Record<string, string>;
	readonly children?: HtmlNode[];
	readonly parent?: HtmlNode | null;
	readonly prev?: HtmlNode | null;
}

/** The HTML parser and css-tree adapter the cascade needs. */
export interface DomModules {
	selectAll(selector: string, nodes: readonly HtmlNode[]): HtmlNode[];
	selectOne(selector: string, nodes: readonly HtmlNode[]): HtmlNode | null;
	compile(selector: string): (node: HtmlNode) => boolean;
	readonly domutils: { textContent(node: HtmlNode): string };
	readonly csstree: {
		parse(css: string, options: { positions: boolean; parseValue: boolean; parseCustomProperty: boolean }): CsstreeAst;
		generate(node: unknown): string;
	};
}

interface CsstreeAst {
	readonly children?: CsstreeList;
}

interface CsstreeList {
	forEach?(callback: (node: CsstreeNode) => void): void;
}

interface CsstreeNode {
	readonly type: string;
	readonly name?: string;
	readonly prelude?: unknown;
	readonly block?: { readonly children?: CsstreeList } | null;
	readonly important?: boolean;
	readonly property?: string;
	readonly value?: unknown;
}

/** One declaration as authored, before expansion. */
export interface StaticDeclaration {
	readonly prop: string;
	readonly value: string;
	readonly important: boolean;
	readonly order: number;
}

/** A cascaded declaration: its value plus the weight it carries. */
interface CascadedDeclaration {
	readonly prop: string;
	readonly value: string;
	readonly important: boolean;
	readonly specificity: readonly number[];
	readonly order: number;
	readonly inline: boolean;
}

/** One selector with the declarations it declares. */
interface StaticRule {
	readonly selector: string;
	readonly declarations: readonly StaticDeclaration[];
	readonly specificity: readonly [number, number, number];
	readonly order: number;
	readonly isHover: boolean;
	/** For a `:hover` rule, the selector with the state removed, so its target can be found. */
	readonly matchSelector: string | null;
}

// ─── Declaration expansion ─────────────────────────────────────────────────

/**
 * Expand one authored declaration into the longhand pairs the cascade compares.
 *
 * The `background` shorthand is where a wrong expansion silently breaks contrast checks:
 * it resets every longhand it does not set, so `pre code { background: none }` must clear
 * an earlier background color rather than leave it standing for the checks to measure
 * text against.
 */
function expandStaticDeclaration(prop: string, value: string): Array<[string, string]> {
	const p = prop.toLowerCase();
	const v = String(value || "").trim();
	if (!v) return [];
	if (p.startsWith("--")) return [[p, v]];

	if (p === "background") {
		const out: Array<[string, string]> = [];
		const hasImage = /gradient|url\(/i.test(v);
		if (hasImage) out.push(["backgroundImage", v]);
		const beforeImage = hasImage ? v.split(/(?:repeating-)?(?:linear|radial|conic)-gradient\(|url\(/i)[0] : v;
		const color = extractStaticColor(hasImage ? beforeImage : v);
		if (color) out.push(["backgroundColor", color]);

		// Reset the longhands it did not set, unless a var() may resolve to a color later.
		if (!color && !hasImage && !/var\(/i.test(v)) {
			out.push(["backgroundColor", "rgba(0, 0, 0, 0)"]);
			out.push(["backgroundImage", "none"]);
		}
		return out;
	}

	if (p === "border") {
		const parsed = parseStaticBorder(v);
		const out: Array<[string, string]> = [];
		for (const side of ["Top", "Right", "Bottom", "Left"]) {
			if (parsed.width) out.push([`border${side}Width`, parsed.width]);
			if (parsed.color) out.push([`border${side}Color`, parsed.color]);
		}
		return out;
	}

	if (p === "outline") {
		// `outline` is width | style | color in any order. The border parser covers width
		// and color; the style keyword is sniffed from the tokens. `outline: 0` zeros the
		// width and effectively hides the outline.
		const tokens = splitCssTokens(v);
		const parsed = parseStaticBorder(v);
		const styleToken = tokens.find((t) => /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(t));
		const out: Array<[string, string]> = [];
		if (parsed.width) out.push(["outlineWidth", parsed.width]);
		if (parsed.color) out.push(["outlineColor", parsed.color]);
		if (styleToken) out.push(["outlineStyle", styleToken.toLowerCase()]);
		if (!parsed.width && /^0(?:px|rem|em|%)?$/.test(v.trim())) out.push(["outlineWidth", "0px"]);
		return out;
	}

	const sideMatch = p.match(/^border-(top|right|bottom|left)$/);
	if (sideMatch) {
		const parsed = parseStaticBorder(v);
		const side = sideMatch[1][0].toUpperCase() + sideMatch[1].slice(1);
		return [
			...(parsed.width ? [[`border${side}Width`, parsed.width] as [string, string]] : []),
			...(parsed.color ? [[`border${side}Color`, parsed.color] as [string, string]] : []),
		];
	}

	if (p === "border-width" || p === "border-color") {
		const vals = expandStaticBoxValues(splitCssTokens(v));
		const suffix = p === "border-width" ? "Width" : "Color";
		return [
			[`borderTop${suffix}`, vals[0]],
			[`borderRight${suffix}`, vals[1]],
			[`borderBottom${suffix}`, vals[2]],
			[`borderLeft${suffix}`, vals[3]],
		];
	}

	if (p === "padding" || p === "margin") {
		const vals = expandStaticBoxValues(splitCssTokens(v));
		const prefix = p === "padding" ? "padding" : "margin";
		return [
			[`${prefix}Top`, vals[0]],
			[`${prefix}Right`, vals[1]],
			[`${prefix}Bottom`, vals[2]],
			[`${prefix}Left`, vals[3]],
		];
	}

	if (p === "font") return parseStaticFont(v);
	if (p === "transition") {
		const parsed = parseStaticTransition(v);
		return [
			...(parsed.property ? ([["transitionProperty", parsed.property]] as Array<[string, string]>) : []),
			...(parsed.timing ? ([["transitionTimingFunction", parsed.timing]] as Array<[string, string]>) : []),
		];
	}
	if (p === "animation") {
		const parsed = parseStaticAnimation(v);
		return [
			...(parsed.name ? ([["animationName", parsed.name]] as Array<[string, string]>) : []),
			...(parsed.timing ? ([["animationTimingFunction", parsed.timing]] as Array<[string, string]>) : []),
		];
	}

	const mapped = cssPropToCamel(p);
	if (STATIC_DEFAULT_STYLE[mapped] != null || STATIC_INHERITED_PROP_SET.has(mapped)) return [[mapped, v]];
	return [];
}

const STATIC_INHERITED_PROP_SET = STATIC_INHERITED_PROPS;

// ─── Cascade weight ────────────────────────────────────────────────────────

/** True when `b` outranks `a`: importance, then inline, then specificity, then order. */
function compareStaticPriority(a: CascadedDeclaration | undefined, b: CascadedDeclaration): boolean {
	if (!a) return true;
	if (!!b.important !== !!a.important) return !!b.important;
	if (!!b.inline !== !!a.inline) return !!b.inline;
	for (let i = 0; i < 3; i++) {
		if ((b.specificity[i] || 0) !== (a.specificity[i] || 0)) return (b.specificity[i] || 0) > (a.specificity[i] || 0);
	}
	return b.order >= a.order;
}

/** The [ids, classes, types] tuple of a selector. `:where()` contributes nothing by spec. */
function staticSpecificity(selector: string): [number, number, number] {
	const noWhere = selector.replace(/:where\([^)]*\)/g, "");
	const ids = (noWhere.match(/#[\w-]+/g) || []).length;
	const classes = (noWhere.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
	const stripped = noWhere
		.replace(/#[\w-]+/g, " ")
		.replace(/\.[\w-]+|\[[^\]]+\]|:{1,2}[\w-]+(?:\([^)]*\))?/g, " ")
		.replace(/[*>+~(),]/g, " ");
	const types = (stripped.match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
	return [ids, classes, types];
}

/** Record a declaration for a node, keeping only the winner per longhand. */
function applyStaticDeclaration(
	specified: Map<HtmlNode, Map<string, CascadedDeclaration>>,
	node: HtmlNode,
	prop: string,
	value: string,
	meta: Omit<CascadedDeclaration, "prop" | "value">,
): void {
	let map = specified.get(node);
	if (!map) {
		map = new Map();
		specified.set(node, map);
	}
	for (const [expandedProp, expandedValue] of expandStaticDeclaration(prop, value)) {
		const existing = map.get(expandedProp);
		const next: CascadedDeclaration = { ...meta, prop: expandedProp, value: expandedValue };
		if (compareStaticPriority(existing, next)) map.set(expandedProp, next);
	}
}

/** The declarations of a `style="…"` attribute. */
function parseStaticStyleAttribute(styleText: string, orderBase = 0): StaticDeclaration[] {
	const decls: StaticDeclaration[] = [];
	for (const part of String(styleText || "").split(";")) {
		const idx = part.indexOf(":");
		if (idx <= 0) continue;
		const prop = part.slice(0, idx).trim();
		let value = part.slice(idx + 1).trim();
		const important = /!important\s*$/i.test(value);
		value = value.replace(/\s*!important\s*$/i, "").trim();
		decls.push({ prop, value, important, order: orderBase + decls.length });
	}
	return decls;
}

/**
 * Every style rule in a stylesheet, with its declarations, specificity, and source order.
 *
 * Two things are deliberately not flattened away: `@media`/`@supports` bodies are walked as
 * if they applied (a file scan cannot evaluate conditions, and the rules inside still
 * describe the design), and `:hover` rules are tagged rather than dropped, because they
 * carry real cascade weight while hovered.
 */
function collectStaticCssRules(cssText: string, csstree: DomModules["csstree"]): StaticRule[] {
	const rules: StaticRule[] = [];
	let ast: CsstreeAst;
	try {
		ast = csstree.parse(cssText, { positions: false, parseValue: true, parseCustomProperty: false });
	} catch {
		return rules;
	}

	let order = 0;
	const walkList = (list: CsstreeList | undefined, atRuleStack: readonly string[] = []): void => {
		list?.forEach?.((node) => {
			if (node.type === "Rule" && node.block) {
				if (atRuleStack.some((name) => /keyframes$/i.test(name))) return;
				const selectorText = csstree.generate(node.prelude).trim();

				const declarations: StaticDeclaration[] = [];
				node.block.children?.forEach?.((child) => {
					if (child.type !== "Declaration") return;
					declarations.push({
						prop: child.property ?? "",
						value: csstree.generate(child.value).trim(),
						important: !!child.important,
						order: declarations.length,
					});
				});

				for (const selector of splitCssList(selectorText)) {
					if (!selector) continue;
					// A `:hover` rule cannot be matched as written (there is no interaction
					// state in a file), so it is tagged and given a state-stripped selector.
					// Specificity still comes from the original: per CSS, `:hover` counts as
					// a class.
					const isHover = /:hover\b/i.test(selector);
					let matchSelector: string | null = null;
					if (isHover) {
						matchSelector = selector.replace(/:hover\b/gi, "").trim();
						if (!matchSelector || /[>+~]\s*$/.test(matchSelector)) matchSelector = null;
						else matchSelector = matchSelector.replace(/(^|[\s>+~])(?=$|[\s>+~])/g, "$1*");
					}
					rules.push({ selector, declarations, specificity: staticSpecificity(selector), order: order++, isHover, matchSelector });
				}
				return;
			}

			if (node.type === "Atrule" && node.block) {
				const name = String(node.name || "").toLowerCase();
				if (name === "media" || name === "supports" || name === "layer") {
					walkList(node.block.children, [...atRuleStack, name]);
				}
			}
		});
	};

	walkList(ast.children);
	return rules;
}

// ─── Static DOM ────────────────────────────────────────────────────────────

/** A parsed element wrapped in the DOM surface the checks expect. */
export class StaticElement {
	readonly node: HtmlNode;
	readonly nodeType = 1;
	readonly tagName: string;
	readonly nodeName: string;
	private readonly doc: StaticDocument;

	constructor(node: HtmlNode, doc: StaticDocument) {
		this.node = node;
		this.doc = doc;
		this.tagName = String(node.name || "").toUpperCase();
		this.nodeName = this.tagName;
	}

	get parentElement(): StaticElement | null {
		let cur = this.node.parent;
		while (cur && cur.type !== "tag") cur = cur.parent;
		return cur ? this.doc.wrap(cur) : null;
	}

	get previousElementSibling(): StaticElement | null {
		let cur = this.node.prev;
		while (cur && cur.type !== "tag") cur = cur.prev;
		return cur ? this.doc.wrap(cur) : null;
	}

	get nextElementSibling(): StaticElement | null {
		const siblings = this.node.parent?.children ?? [];
		const index = siblings.indexOf(this.node);
		if (index === -1) return null;
		for (let i = index + 1; i < siblings.length; i++) {
			if (siblings[i].type === "tag") return this.doc.wrap(siblings[i]);
		}
		return null;
	}

	get children(): StaticElement[] {
		return (this.node.children || []).filter((child) => child.type === "tag").map((child) => this.doc.wrap(child));
	}

	get childNodes(): Array<{ nodeType: number; textContent: string | null }> {
		return (this.node.children || []).map((child) => {
			if (child.type === "text") return { nodeType: 3, textContent: child.data || "" };
			if (child.type === "tag") return this.doc.wrap(child);
			return { nodeType: 8, textContent: child.data || "" };
		});
	}

	get textContent(): string {
		return this.doc.domutils.textContent(this.node);
	}

	get className(): string {
		return this.getAttribute("class") || "";
	}

	get id(): string {
		return this.getAttribute("id") || "";
	}

	getAttribute(name: string): string | null {
		return this.node.attribs?.[name] ?? null;
	}

	querySelector(selector: string): StaticElement | null {
		try {
			const found = this.doc.selectOne(selector, this.node.children || []);
			return found ? this.doc.wrap(found) : null;
		} catch {
			return null;
		}
	}

	querySelectorAll(selector: string): StaticElement[] {
		try {
			return this.doc.selectAll(selector, this.node.children || []).map((node) => this.doc.wrap(node));
		} catch {
			return [];
		}
	}

	closest(selector: string): StaticElement | null {
		const matcher = this.doc.matcherFor(selector);
		let cur: HtmlNode | null = this.node;
		while (cur && cur.type === "tag") {
			try {
				if (matcher(cur)) return this.doc.wrap(cur);
			} catch {
				return null;
			}
			cur = cur.parent ?? null;
			while (cur && cur.type !== "tag") cur = cur.parent ?? null;
		}
		return null;
	}

	contains(other: unknown): boolean {
		let cur: HtmlNode | null = (other as { node?: HtmlNode } | null | undefined)?.node ?? null;
		while (cur) {
			if (cur === this.node) return true;
			cur = cur.parent ?? null;
		}
		return false;
	}

	matches(selector: string): boolean {
		try {
			return this.doc.matcherFor(selector)(this.node);
		} catch {
			return false;
		}
	}
}

/** The parsed document, wrapped so the checks can query it and read computed styles. */
export class StaticDocument {
	readonly root: HtmlNode;
	readonly selectAll: DomModules["selectAll"];
	readonly selectOne: DomModules["selectOne"];
	readonly compile: DomModules["compile"];
	readonly domutils: DomModules["domutils"];

	private readonly wrappers = new WeakMap<HtmlNode, StaticElement>();
	private readonly compiledSelectors = new Map<string, (node: HtmlNode) => boolean>();
	private readonly styleMap = new WeakMap<HtmlNode, StaticStyle>();
	private readonly hoverStyleMap = new WeakMap<HtmlNode, StaticStyle>();
	private readonly accentDashPseudo = new WeakSet<HtmlNode>();
	// Elements whose ::before/::after paints a full-cover opaque surface. That pseudo is
	// the visible background for contrast purposes even though it never joins the cascade.
	private readonly pseudoSurface = new WeakMap<HtmlNode, Color>();

	constructor(root: HtmlNode, modules: DomModules) {
		this.root = root;
		this.selectAll = modules.selectAll;
		this.selectOne = modules.selectOne;
		this.compile = modules.compile;
		this.domutils = modules.domutils;
	}

	wrap(node: HtmlNode): StaticElement {
		let wrapped = this.wrappers.get(node);
		if (!wrapped) {
			wrapped = new StaticElement(node, this);
			this.wrappers.set(node, wrapped);
		}
		return wrapped;
	}

	matcherFor(selector: string): (node: HtmlNode) => boolean {
		let matcher = this.compiledSelectors.get(selector);
		if (!matcher) {
			try {
				matcher = this.compile(selector);
			} catch (err) {
				// Cache the failure as a rethrower, so a bad selector reaches the caller's
				// catch on every call, first and repeat alike.
				matcher = () => {
					throw err;
				};
			}
			this.compiledSelectors.set(selector, matcher);
		}
		return matcher;
	}

	querySelectorAll(selector: string): StaticElement[] {
		try {
			return this.selectAll(selector, this.root.children || []).map((node) => this.wrap(node));
		} catch {
			return [];
		}
	}

	querySelector(selector: string): StaticElement | null {
		try {
			const found = this.selectOne(selector, this.root.children || []);
			return found ? this.wrap(found) : null;
		} catch {
			return null;
		}
	}

	get documentElement(): StaticElement | null {
		return this.querySelector("html");
	}

	get body(): StaticElement | null {
		return this.querySelector("body");
	}

	setStyle(node: HtmlNode, style: StaticStyle): void {
		this.styleMap.set(node, style);
	}

	getStyle(el: StaticElement): StaticStyle {
		return this.styleMap.get(el.node) ?? makeStaticStyle();
	}

	setHoverStyle(node: HtmlNode, style: StaticStyle): void {
		this.hoverStyleMap.set(node, style);
	}

	getHoverStyle(el: StaticElement): StaticStyle | null {
		return this.hoverStyleMap.get(el.node) ?? null;
	}

	setAccentDashPseudo(node: HtmlNode): void {
		this.accentDashPseudo.add(node);
	}

	hasAccentDashPseudo(el: StaticElement): boolean {
		return this.accentDashPseudo.has(el.node);
	}

	setPseudoSurface(node: HtmlNode, color: Color): void {
		this.pseudoSurface.set(node, color);
	}

	getPseudoSurface(el: StaticElement): Color | null {
		return this.pseudoSurface.get(el.node) ?? null;
	}

	/** The stylesheet text the cascade was built from, for checks that read raw CSS. */
	readonly styleSheets?: ArrayLike<unknown>;
}

/**
 * A computed style: the defaults, the resolved values, and a property accessor. Typed as the
 * checks' `CssStyle` (every property a string) plus the accessor, because that is what a DOM
 * style looks like from the outside; the accessor is attached after the values so it never
 * joins the property map the checks iterate.
 */
export type StaticStyle = CssStyle & { getPropertyValue(prop: string): string };

function makeStaticStyle(values: Record<string, string> = {}): StaticStyle {
	const style: Record<string, string> = { ...STATIC_DEFAULT_STYLE, ...values };
	return Object.assign(style, {
		getPropertyValue: (prop: string): string => {
			const key = cssPropToCamel(prop);
			return style[key] || style[prop] || "";
		},
	}) as StaticStyle;
}

/** The `window`-shaped object the checks read: computed styles plus the two pseudo facts. */
function buildStaticWindow(staticDoc: StaticDocument) {
	return {
		document: staticDoc,
		getComputedStyle: (el: StaticElement) => staticDoc.getStyle(el),
		getHoverStyle: (el: StaticElement) => staticDoc.getHoverStyle(el),
		hasAccentDashPseudo: (el: StaticElement) => staticDoc.hasAccentDashPseudo(el),
		getPseudoSurface: (el: StaticElement) => staticDoc.getPseudoSurface(el),
	};
}

// ─── Style map ─────────────────────────────────────────────────────────────

/**
 * Resolve a linked stylesheet's path. A cache-busting query is dropped, and a
 * root-relative href is resolved against the file's directory walking up to the project
 * root, so `/static/app.css` is not read as an OS-absolute path.
 */
function resolveLinkedCssPath(fileDir: string, href: string): string {
	const stripped = href.split(/[?#]/)[0];
	const rootRelative = stripped.startsWith("/") && !stripped.startsWith("//");
	if (!rootRelative) return path.resolve(fileDir, stripped);

	// Drop "." and reject ".." so /../outside.css cannot walk out of the directory.
	const segments = stripped.replace(/^\/+/, "").split(/[/\\]/).filter((p) => p && p !== ".");
	if (segments.some((p) => p === "..")) return path.join(fileDir, segments.filter((p) => p !== "..").join(path.sep));

	const rel = segments.join(path.sep);
	let dir = fileDir;
	for (;;) {
		const parent = path.dirname(dir);
		if (parent === dir) break; // never use the filesystem root as the document root
		try {
			const candidate = path.join(dir, rel);
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// Missing or unreadable candidate: keep walking.
		}
		// Stop at the project root so a coincidental ~/static/app.css cannot win.
		try {
			if (fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, ".git"))) break;
		} catch {
			// Unreadable marker: keep walking.
		}
		dir = parent;
	}
	return path.join(fileDir, rel);
}

/**
 * The CSS a page carries: its `<style>` blocks plus the local stylesheets it links. A
 * remote stylesheet is skipped (a scan does not fetch), and a missing local one is
 * reported once rather than silently flattening every color rule.
 */
function collectStaticCssText(
	root: HtmlNode,
	fileDir: string,
	modules: DomModules,
	onMissingStylesheet: (href: string, resolved: string) => void = () => {},
): string {
	const styleTexts: string[] = [];
	const warned = new Set<string>();

	for (const styleEl of modules.selectAll("style", root.children || [])) {
		styleTexts.push(modules.domutils.textContent(styleEl));
	}

	for (const link of modules.selectAll("link", root.children || [])) {
		const rel = link.attribs?.rel || "";
		const href = link.attribs?.href || "";
		if (!/\bstylesheet\b/i.test(rel) || !href || /^(https?:)?\/\//i.test(href)) continue;

		const cssPath = resolveLinkedCssPath(fileDir, href);
		try {
			styleTexts.push(fs.readFileSync(cssPath, "utf-8"));
		} catch {
			if (!warned.has(cssPath)) {
				warned.add(cssPath);
				onMissingStylesheet(href, cssPath);
			}
		}
	}

	return styleTexts.join("\n");
}

/**
 * Compute a style for every element in the document: match the rules, apply the
 * declarations by weight, inherit what inherits, resolve custom properties, and record the
 * hover style plus the two pseudo-element facts the checks consume.
 */
function buildStaticStyleMap(root: HtmlNode, staticDoc: StaticDocument, cssText: string, modules: DomModules): void {
	const specified = new Map<HtmlNode, Map<string, CascadedDeclaration>>();
	// Declarations from `:hover` rules, matched via their state-stripped selectors and
	// merged per property against the resting cascade: a hover declaration only takes
	// effect if it would win while hovered, when the resting rules still apply.
	const hoverSpecified = new Map<HtmlNode, Map<string, CascadedDeclaration>>();
	const rootCustomProps = collectCssCustomProps(cssText);
	const allNodes = modules.selectAll("*", root.children || []);
	const rules = collectStaticCssRules(cssText, modules.csstree);

	for (const rule of rules) {
		// `::before`/`::after` rules cannot join the element cascade (pseudo-elements are
		// not DOM nodes), but two shapes matter to the checks that read them.
		if (!rule.isHover) {
			const pm = rule.selector.match(/^(.+?)\s*::?(?:before|after)$/i);
			if (pm) {
				const decls = new Map<string, string>();
				for (const d of rule.declarations) decls.set(d.prop.toLowerCase(), d.value);

				// The kicker dash: a short chromatic bar, 8–80px wide and 1–6px tall.
				const w = cssLengthToPx(resolveVarRefs(decls.get("width") || decls.get("inline-size") || "", rootCustomProps));
				const h = cssLengthToPx(resolveVarRefs(decls.get("height") || decls.get("block-size") || "", rootCustomProps));
				if (w != null && h != null && w >= 8 && w <= 80 && h >= 1 && h <= 6) {
					const bgRaw = String(resolveVarRefs(decls.get("background-color") || decls.get("background") || "", rootCustomProps));
					const token = bgRaw.match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\([^)]*(?:\([^)]*\))?[^)]*\)|#[0-9a-f]{3,8}\b/i);
					const c = parseAnyColor(token ? token[0] : bgRaw);
					if (c && c.a >= 0.1 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) >= 30) {
						try {
							for (const node of modules.selectAll(pm[1], root.children || [])) staticDoc.setAccentDashPseudo(node);
						} catch {
							// Unsupported base selector: no mark, which is the abstention.
						}
					}
				}

				// The full-cover surface pseudo: the CTA construction where the element stays
				// transparent and a positioned pseudo with a zero inset and an opaque
				// background paints the visible surface.
				const pseudoPos = String(decls.get("position") || "").toLowerCase();
				if (pseudoPos === "absolute" || pseudoPos === "fixed") {
					const zeroLen = (v: string | undefined) => v != null && /^0(?:px)?$/.test(String(v).trim());
					const insetRaw = String(decls.get("inset") || "").trim();
					const coversBox =
						(insetRaw !== "" && insetRaw.split(/\s+/).every((t) => /^0(?:px)?$/.test(t))) ||
						["top", "right", "bottom", "left"].every((side) => zeroLen(decls.get(side))) ||
						(String(decls.get("width") || "").trim() === "100%" && String(decls.get("height") || "").trim() === "100%");
					if (coversBox && decls.has("content")) {
						const surfRaw = String(resolveVarRefs(decls.get("background-color") || decls.get("background") || "", rootCustomProps));
						const surfToken = surfRaw.match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\([^)]*(?:\([^)]*\))?[^)]*\)|#[0-9a-f]{3,8}\b/i);
						const surf = parseAnyColor(surfToken ? surfToken[0] : surfRaw);
						if (surf && surf.a >= 0.9 && !/gradient/i.test(surfRaw)) {
							try {
								for (const node of modules.selectAll(pm[1], root.children || [])) staticDoc.setPseudoSurface(node, surf);
							} catch {
								// Unsupported base selector: no surface recorded.
							}
						}
					}
				}
				continue;
			}
		}

		const matchSelector = rule.isHover ? rule.matchSelector : rule.selector;
		if (!matchSelector) continue;

		let matched: HtmlNode[];
		try {
			matched = modules.selectAll(matchSelector, root.children || []);
		} catch {
			// An unsupported selector is skipped rather than guessed at.
			continue;
		}

		for (const node of matched) {
			for (const decl of rule.declarations) {
				applyStaticDeclaration(rule.isHover ? hoverSpecified : specified, node, decl.prop, decl.value, {
					important: decl.important,
					specificity: rule.specificity,
					order: rule.order,
					inline: false,
				});
			}
		}
	}

	// Inline styles come after every rule, spaced far enough apart that source order among
	// them still decides.
	let inlineOrder = rules.length + 1;
	for (const node of allNodes) {
		const styleText = node.attribs?.style;
		if (!styleText) continue;
		for (const decl of parseStaticStyleAttribute(styleText, inlineOrder)) {
			applyStaticDeclaration(specified, node, decl.prop, decl.value, {
				important: decl.important,
				specificity: [1, 0, 0],
				order: decl.order,
				inline: true,
			});
		}
		inlineOrder += 1000;
	}

	const computeNode = (node: HtmlNode, parentStyle: StaticStyle | null = null, parentCustom: Map<string, string> = new Map()): void => {
		const specifiedMap = specified.get(node) ?? new Map<string, CascadedDeclaration>();

		const customProps = new Map(parentCustom);
		for (const [prop, decl] of specifiedMap) {
			if (prop.startsWith("--")) customProps.set(prop, resolveVarRefs(decl.value, customProps));
		}

		const values: Record<string, string> = {};
		for (const prop of Object.keys(STATIC_DEFAULT_STYLE)) {
			if (STATIC_INHERITED_PROP_SET.has(prop) && parentStyle?.[prop] != null) values[prop] = parentStyle[prop] as string;
			else values[prop] = STATIC_DEFAULT_STYLE[prop];
		}
		for (const [prop, decl] of specifiedMap) {
			if (prop.startsWith("--")) continue;
			values[prop] = normalizeStaticCssValue(prop, decl.value, customProps, parentStyle as Record<string, string> | null, values);
		}

		const style = makeStaticStyle(values);
		staticDoc.setStyle(node, style);

		// Hover pass: limited to the two properties the hover-contrast check consumes. A
		// hover declaration wins only if it beats the resting winner for that property.
		const hoverMap = hoverSpecified.get(node);
		if (hoverMap) {
			let hoverValues: Record<string, string> | null = null;
			for (const prop of ["color", "backgroundColor"]) {
				const hoverDecl = hoverMap.get(prop);
				if (!hoverDecl) continue;
				const restingDecl = specifiedMap.get(prop);
				if (!compareStaticPriority(restingDecl, hoverDecl)) continue;
				const next = normalizeStaticCssValue(prop, hoverDecl.value, customProps, parentStyle as Record<string, string> | null, values);
				if (next === values[prop]) continue;
				if (!hoverValues) hoverValues = { ...values };
				hoverValues[prop] = next;
			}
			if (hoverValues) staticDoc.setHoverStyle(node, makeStaticStyle(hoverValues));
		}

		for (const child of node.children || []) {
			if (child.type === "tag") computeNode(child, style, customProps);
		}
	};

	for (const child of root.children || []) {
		if (child.type === "tag") computeNode(child);
	}
}

export {
	applyStaticDeclaration,
	buildStaticStyleMap,
	buildStaticWindow,
	collectStaticCssRules,
	collectStaticCssText,
	compareStaticPriority,
	expandStaticDeclaration,
	makeStaticStyle,
	parseStaticStyleAttribute,
	resolveLinkedCssPath,
	staticSpecificity,
};
export type { CascadedDeclaration, StaticRule };
