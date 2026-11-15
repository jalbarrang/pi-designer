/**
 * The unified `.impeccable` config: reading and writing the detector filters, and the
 * matching that turns them into suppressions. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Two config files, one schema: `config.json` is shared and committed,
 * `config.local.json` is per developer and gitignored, and local values merge over shared
 * ones. The detector filters are `ignoreRules`, `ignoreFiles` (globs), `ignoreValues`
 * (rule/value pairs, optionally file-scoped), and a `designSystem` toggle.
 *
 * The git-exclude and hook-consent helpers are not here: pi registers no hooks, so it has
 * nothing to consent to and no local file it must hide from git.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Finding } from "./types.ts";

/** The shared config path under a project root. */
function getConfigPath(root: string): string {
	return join(root, ".impeccable", "config.json");
}

/** The per-developer config path under a project root. */
function getLocalConfigPath(root: string): string {
	return join(root, ".impeccable", "config.local.json");
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function hookSection(raw: Record<string, unknown> | null): Record<string, unknown> | null {
	const hook = raw?.hook;
	return hook && typeof hook === "object" && !Array.isArray(hook) ? (hook as Record<string, unknown>) : null;
}

function detectorSection(raw: Record<string, unknown> | null): Record<string, unknown> | null {
	const detector = raw?.detector;
	return detector && typeof detector === "object" && !Array.isArray(detector) ? (detector as Record<string, unknown>) : null;
}

const DETECTOR_CONFIG_KEYS: ReadonlySet<string> = new Set(["ignoreRules", "ignoreFiles", "ignoreValues", "designSystem", "advisoryRules"]);

/** One suppression of a rule's value, optionally scoped to files. */
export interface IgnoreValueEntry {
	readonly rule: string;
	readonly value: string;
	readonly files?: readonly string[];
	readonly createdAt?: string;
	readonly reason?: string;
}

/** The detector filters a scan applies. */
export interface DetectionConfigState {
	ignoreRules: string[];
	ignoreFiles: string[];
	ignoreValues: IgnoreValueEntry[];
	designSystem: { enabled: boolean };
	advisoryRules?: "include" | "exclude";
}

/** The filters as read from disk, which is what a scan needs. */
export interface DetectionConfig {
	readonly ignoreRules: readonly string[];
	readonly ignoreFiles: readonly string[];
	readonly ignoreValues: readonly IgnoreValueEntry[];
	readonly designSystem?: { readonly enabled?: boolean };
	readonly advisoryRules?: "include" | "exclude";
}

/** The defaults a project without a config file gets: no suppressions, design file on. */
const DEFAULT_DETECTION_CONFIG = Object.freeze({
	ignoreRules: [] as string[],
	ignoreFiles: [] as string[],
	ignoreValues: [] as IgnoreValueEntry[],
	designSystem: { enabled: true },
});

function cloneDetectionConfig(): DetectionConfigState {
	return {
		ignoreRules: [],
		ignoreFiles: [],
		ignoreValues: [],
		designSystem: { ...DEFAULT_DETECTION_CONFIG.designSystem },
	};
}

/** Fold one config file's detector section (or a legacy `hook` section) into the state. */
function applyDetectionConfigSource(config: DetectionConfigState, raw: Record<string, unknown> | null): void {
	if (!raw || typeof raw !== "object") return;

	// Advisory rules are opt-in for the design hook; the value rides along so a config
	// round-trips through a write without losing it.
	if (raw.advisoryRules === "include" || raw.advisoryRules === "exclude") config.advisoryRules = raw.advisoryRules;

	if (raw.designSystem && typeof raw.designSystem === "object" && !Array.isArray(raw.designSystem)) {
		const enabled = (raw.designSystem as { enabled?: unknown }).enabled;
		config.designSystem = { ...config.designSystem, enabled: enabled === false ? false : true };
	}
	if (Array.isArray(raw.ignoreRules)) config.ignoreRules = uniqueStrings([...config.ignoreRules, ...raw.ignoreRules]);
	if (Array.isArray(raw.ignoreFiles)) config.ignoreFiles = uniqueStrings([...config.ignoreFiles, ...raw.ignoreFiles]);
	if (Array.isArray(raw.ignoreValues)) config.ignoreValues = mergeIgnoreValues(config.ignoreValues, raw.ignoreValues);
}

function uniqueStrings(values: readonly unknown[]): string[] {
	return Array.from(new Set(values.map(String)));
}

/**
 * The detector filters for a project: shared config first, then the per-developer file over
 * it. Old builds stored the filters under `hook.*`, so that section is still read.
 */
function readDetectionConfig(root: string): DetectionConfigState {
	const config = cloneDetectionConfig();
	for (const filePath of [getConfigPath(root), getLocalConfigPath(root)]) {
		const raw = safeReadJson(filePath);
		applyDetectionConfigSource(config, hookSection(raw));
		applyDetectionConfigSource(config, detectorSection(raw));
	}
	return config;
}

/**
 * Write the detector filters back, touching nothing else in the file: sibling sections and
 * unknown keys survive, and `hook.*` keeps only the keys the detector does not own.
 */
function writeDetectionConfig(root: string, detectorConfig: Partial<DetectionConfigState>, opts: { readonly local?: boolean } = {}): string {
	const filePath = opts.local ? getLocalConfigPath(root) : getConfigPath(root);
	const existing = safeReadJson(filePath) ?? {};

	const nextHook = stripDetectorKeys(hookSection(existing));
	const next: Record<string, unknown> = {
		...existing,
		detector: { ...(detectorSection(existing) ?? {}), ...normalizeDetectionConfigForWrite(detectorConfig) },
	};
	if (nextHook && Object.keys(nextHook).length > 0) next.hook = nextHook;
	else delete next.hook;

	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
	return filePath;
}

function normalizeDetectionConfigForWrite(config: Partial<DetectionConfigState>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (Array.isArray(config.ignoreRules)) {
		out.ignoreRules = uniqueStrings(config.ignoreRules.map((rule) => normalizeIgnoreRule(rule)).filter(Boolean));
	}
	if (Array.isArray(config.ignoreFiles)) {
		out.ignoreFiles = uniqueStrings(config.ignoreFiles.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()));
	}
	out.ignoreValues = normalizeIgnoreValueEntries(config.ignoreValues ?? []);
	if (config.advisoryRules === "include" || config.advisoryRules === "exclude") out.advisoryRules = config.advisoryRules;
	if (config.designSystem && typeof config.designSystem === "object" && !Array.isArray(config.designSystem)) {
		out.designSystem = { enabled: config.designSystem.enabled === false ? false : true };
	}
	return out;
}

function stripDetectorKeys(raw: Record<string, unknown> | null): Record<string, unknown> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!DETECTOR_CONFIG_KEYS.has(key)) out[key] = value;
	}
	return out;
}

// ─── Ignore matching ───────────────────────────────────────────────────────

/** A value in the form a config entry and a finding can both be compared in. */
function normalizeIgnoreValue(value: unknown): string {
	return String(value || "")
		.trim()
		.replace(/^["']|["']$/g, "")
		.replace(/\+/g, " ")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function normalizeIgnoreRule(rule: unknown): string {
	return String(rule || "").trim().toLowerCase();
}

/** A color compared by channels and 8-bit alpha, so `#f00` matches `rgb(255, 0, 0)`. */
function colorIgnoreKey(value: string): string {
	const color = parseIgnoreColor(value);
	if (!color) return "";
	return `${color.r},${color.g},${color.b},${Math.round(color.a * 255)}`;
}

interface Rgba {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
}

function parseIgnoreColor(value: string): Rgba | null {
	const text = String(value || "").trim().toLowerCase();
	if (!text) return null;

	const hex = text.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
	if (hex) return parseHexIgnoreColor(hex[1]);

	const rgb = text.match(/^rgba?\((.*)\)$/i);
	if (rgb) {
		const parts = splitColorArgs(rgb[1]);
		if (parts.length < 3 || parts.length > 4) return null;
		const r = parseColorChannel(parts[0], COLOR_CHANNEL_FORMATS.rgb);
		const g = parseColorChannel(parts[1], COLOR_CHANNEL_FORMATS.rgb);
		const b = parseColorChannel(parts[2], COLOR_CHANNEL_FORMATS.rgb);
		const a = parts[3] === undefined ? 1 : parseColorChannel(parts[3], COLOR_CHANNEL_FORMATS.alpha);
		if ([r, g, b, a].some((v) => v === null)) return null;
		return { r: r as number, g: g as number, b: b as number, a: a as number };
	}

	const hsl = text.match(/^hsla?\((.*)\)$/i);
	if (hsl) {
		const parts = splitColorArgs(hsl[1]);
		if (parts.length < 3 || parts.length > 4) return null;
		const h = parseColorChannel(parts[0], COLOR_CHANNEL_FORMATS.hue);
		const s = parseColorChannel(parts[1], COLOR_CHANNEL_FORMATS.percent);
		const l = parseColorChannel(parts[2], COLOR_CHANNEL_FORMATS.percent);
		const a = parts[3] === undefined ? 1 : parseColorChannel(parts[3], COLOR_CHANNEL_FORMATS.alpha);
		if ([h, s, l, a].some((v) => v === null)) return null;
		return hslToRgb(h as number, s as number, l as number, a as number);
	}

	return null;
}

function parseHexIgnoreColor(hex: string): Rgba {
	const expanded = hex.length <= 4 ? [...hex].map((digit) => digit.repeat(2)).join("") : hex;
	const [r, g, b, alpha = 255] = (expanded.match(/../g) ?? []).map((channel) => Number.parseInt(channel, 16));
	return { r, g, b, a: alpha / 255 };
}

/** Split a color's arguments, which may be comma-separated or space-separated with a slash. */
function splitColorArgs(body: string): string[] {
	const text = String(body || "").trim();
	if (!text) return [];
	if (text.includes(",")) {
		const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
		const last = parts[parts.length - 1];
		if (last && last.includes("/")) {
			const split = last.split("/").map((part) => part.trim()).filter(Boolean);
			return [...parts.slice(0, -1), ...split];
		}
		return parts;
	}
	return text.replace(/\s*\/\s*/g, " / ").split(/\s+/).filter((part) => part && part !== "/");
}

const CSS_NUMBER_RE = /^(-?\d*\.?\d+)(%|deg|rad|turn|grad)?$/;
const identity = (value: number): number => value;

const COLOR_CHANNEL_FORMATS = {
	rgb: { units: { "": identity, "%": (value: number) => value * 2.55 }, min: 0, max: 255, round: true },
	alpha: { units: { "": identity, "%": (value: number) => value / 100 }, min: 0, max: 1, round: false },
	hue: {
		units: {
			"": identity,
			deg: identity,
			rad: (value: number) => value * (180 / Math.PI),
			turn: (value: number) => value * 360,
			grad: (value: number) => value * 0.9,
		},
		min: Number.NEGATIVE_INFINITY,
		max: Number.POSITIVE_INFINITY,
		round: false,
	},
	percent: { units: { "%": (value: number) => value / 100 }, min: 0, max: 1, round: false },
} as const;

function parseColorChannel(
	raw: string,
	{ units, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, round = false }: {
		readonly units: Readonly<Record<string, (value: number) => number>>;
		readonly min?: number;
		readonly max?: number;
		readonly round?: boolean;
	},
): number | null {
	const text = String(raw || "").trim();
	const match = text.match(CSS_NUMBER_RE);
	if (!match) return null;
	const convert = units[match[2] || ""];
	if (!convert) return null;
	const number = Number.parseFloat(match[1]);
	if (!Number.isFinite(number)) return null;
	const value = convert(number);
	if (value < min || value > max) return null;
	return round ? Math.round(value) : value;
}

function clampByte(value: number): number {
	return Math.min(255, Math.max(0, value));
}

function hslToRgb(hue: number, saturation: number, lightness: number, alpha: number): Rgba {
	const h = (((hue % 360) + 360) % 360) / 360;
	if (saturation === 0) {
		const gray = clampByte(Math.round(lightness * 255));
		return { r: gray, g: gray, b: gray, a: alpha };
	}
	const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
	const p = 2 * lightness - q;
	const toRgb = (t: number): number => {
		let channel = t;
		if (channel < 0) channel += 1;
		if (channel > 1) channel -= 1;
		if (channel < 1 / 6) return p + (q - p) * 6 * channel;
		if (channel < 1 / 2) return q;
		if (channel < 2 / 3) return p + (q - p) * (2 / 3 - channel) * 6;
		return p;
	};
	return {
		r: clampByte(Math.round(toRgb(h + 1 / 3) * 255)),
		g: clampByte(Math.round(toRgb(h) * 255)),
		b: clampByte(Math.round(toRgb(h - 1 / 3) * 255)),
		a: alpha,
	};
}

function ignoreValueMatches(rule: string, entryValue: string, findingValue: string): boolean {
	if (entryValue === findingValue) return true;
	if (rule !== "design-system-color") return false;
	const entryColor = colorIgnoreKey(entryValue);
	return Boolean(entryColor && entryColor === colorIgnoreKey(findingValue));
}

/**
 * Normalize config entries. Key order is rule, value, files, createdAt, reason and must stay
 * that way: normalizing runs on every write, so a different order would rewrite every
 * untouched entry and churn the diff.
 */
function normalizeIgnoreValueEntries(entries: readonly unknown[] | null | undefined): IgnoreValueEntry[] {
	if (!Array.isArray(entries)) return [];
	const out: IgnoreValueEntry[] = [];

	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { rule?: unknown; value?: unknown; file?: unknown; files?: unknown; createdAt?: unknown; reason?: unknown };
		const rule = normalizeIgnoreRule(entry.rule);
		const value = normalizeIgnoreValue(entry.value);
		if (!rule || !value) continue;

		const files = uniqueStrings([
			...(typeof entry.file === "string" && entry.file.trim() ? [entry.file.trim()] : []),
			...(Array.isArray(entry.files) ? entry.files.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()) : []),
		]);

		const normalized: IgnoreValueEntry = {
			rule,
			value,
			...(files.length > 0 ? { files } : {}),
			...(typeof entry.createdAt === "string" && entry.createdAt.trim() ? { createdAt: entry.createdAt.trim() } : {}),
			...(typeof entry.reason === "string" && entry.reason.trim() ? { reason: entry.reason.trim() } : {}),
		};
		out.push(normalized);
	}
	return out;
}

function mergeIgnoreValues(existing: readonly unknown[], incoming: readonly unknown[]): IgnoreValueEntry[] {
	const map = new Map<string, IgnoreValueEntry>();
	const key = (entry: IgnoreValueEntry) => `${entry.rule}\u0000${entry.value}\u0000${ignoreValueFilesKey(entry.files)}`;
	for (const entry of normalizeIgnoreValueEntries(existing)) map.set(key(entry), entry);
	for (const entry of normalizeIgnoreValueEntries(incoming)) map.set(key(entry), entry);
	return Array.from(map.values());
}

function ignoreValueFilesKey(files: readonly string[] | undefined): string {
	// A scope is a set, so an entry already on disk in another order must compare equal
	// rather than dedup as two distinct entries.
	return Array.isArray(files) && files.length > 0 ? [...files].sort().join("\x1f") : "";
}

/** Glob to RegExp: `**`, `*`, `?`, and `{a,b}` alternation. */
function globToRegex(glob: string): RegExp {
	let re = "^";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i += 2;
				if (glob[i] === "/") i += 1;
			} else {
				re += "[^/]*";
				i += 1;
			}
		} else if (c === "?") {
			re += "[^/]";
			i += 1;
		} else if (c === "{") {
			const end = glob.indexOf("}", i);
			if (end === -1) {
				re += "\\{";
				i += 1;
				continue;
			}
			const parts = glob
				.slice(i + 1, end)
				.split(",")
				.map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&"));
			re += `(?:${parts.join("|")})`;
			i = end + 1;
		} else if (/[.+^$()|[\]\\]/.test(c)) {
			re += `\\${c}`;
			i += 1;
		} else {
			re += c;
			i += 1;
		}
	}
	re += "$";
	return new RegExp(re);
}

/** True when the path (or its basename) matches any glob. */
function matchesAnyGlob(filePath: string, globs: readonly string[] | null | undefined): boolean {
	if (!Array.isArray(globs) || globs.length === 0) return false;
	const normalized = String(filePath || "").split(sep).join("/");
	for (const glob of globs) {
		try {
			const re = globToRegex(String(glob));
			if (re.test(normalized)) return true;
			const base = normalized.split("/").pop() ?? "";
			if (re.test(base)) return true;
		} catch {
			// A malformed glob is skipped rather than failing the scan.
		}
	}
	return false;
}

/** True when `detector.ignoreFiles` excludes this path, tested absolute and relative. */
function shouldIgnoreDetectionFile(filePath: string, root: string, config: DetectionConfig | null | undefined): boolean {
	const globs = config?.ignoreFiles ?? [];
	if (globs.length === 0) return false;
	const raw = String(filePath || "").trim();
	if (!raw) return false;
	if (matchesAnyGlob(raw, globs)) return true;

	try {
		const abs = isAbsolute(raw) ? raw : resolve(root, raw);
		if (matchesAnyGlob(abs, globs)) return true;
		const rel = relative(root, abs);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return matchesAnyGlob(rel, globs);
	} catch {
		// Unresolvable path: no match.
	}
	return false;
}

/** Apply `ignoreRules` and `ignoreValues` to a finding list. */
function filterDetectionFindings<T extends Finding>(findings: readonly T[], config: DetectionConfig | null | undefined): T[] {
	if (!Array.isArray(findings) || findings.length === 0) return [];
	const ignoreRules = new Set((config?.ignoreRules ?? []).map((rule) => normalizeIgnoreRule(rule)));
	const ignoreValues = normalizeIgnoreValueEntries(config?.ignoreValues ?? []);

	return findings.filter((finding) => {
		if (!finding || typeof finding !== "object") return false;
		if (ignoreRules.has(normalizeIgnoreRule(finding.antipattern))) return false;
		if (isIgnoredFindingValue(finding, ignoreValues)) return false;
		return true;
	});
}

function isIgnoredFindingValue(finding: Finding, ignoreValues: readonly IgnoreValueEntry[]): boolean {
	if (ignoreValues.length === 0) return false;
	const rule = normalizeIgnoreRule(finding.antipattern);
	if (!rule) return false;

	// A file-scoped wildcard also suppresses rules with no extractable value, such as
	// side-tab: that is what makes "this file, every rule" expressible.
	const value = extractFindingIgnoreValue(finding);
	return ignoreValues.some((entry) => {
		if (entry.rule !== rule) return false;
		const wildcardValue = entry.value === "*";
		if (!wildcardValue && (!value || !ignoreValueMatches(rule, entry.value, value))) return false;
		if (!entry.files || entry.files.length === 0) return !wildcardValue;
		return findingMatchesScopedIgnoreFile(finding, entry.files);
	});
}

function findingMatchesScopedIgnoreFile(finding: Finding, globs: readonly string[]): boolean {
	const filePath = String(finding?.file || "").trim();
	if (!filePath) return false;
	if (matchesAnyGlob(filePath, globs)) return true;

	// A config glob is written relative to the project; a finding carries whatever path the
	// scan was given, so every path suffix has to be offered to the matcher.
	const normalized = filePath.split(sep).join("/");
	const parts = normalized.split("/").filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		if (matchesAnyGlob(parts.slice(i).join("/"), globs)) return true;
	}
	return false;
}

/** The value a waiver would name for a finding, or an empty string when the rule has none. */
function extractFindingIgnoreValue(finding: Finding | null | undefined): string {
	if (!finding || typeof finding !== "object") return "";
	const rule = normalizeIgnoreRule(finding.antipattern);
	const directValueRules = new Set([
		"overused-font",
		"bounce-easing",
		"design-system-font",
		"design-system-color",
		"design-system-radius",
		"design-system-font-size",
	]);
	if (!directValueRules.has(rule)) return "";
	return normalizeIgnoreValue(extractFindingIgnoreValueRaw(finding, rule));
}

function extractFindingIgnoreValueRaw(finding: Finding & { value?: string; detail?: string }, rule = normalizeIgnoreRule(finding?.antipattern)): string {
	const direct = cleanIgnoreValueDisplay(finding.ignoreValue || finding.value || "");
	if (direct) return direct;

	for (const text of [finding.detail, finding.snippet].filter((v): v is string => typeof v === "string" && !!v)) {
		if (rule === "bounce-easing") {
			const motion = extractMotionIgnoreValue(text);
			if (motion) return motion;
			continue;
		}

		const primary = text.match(/Primary font:\s*([^()\n;]+)/i);
		if (primary) return cleanIgnoreValueDisplay(primary[1]);

		const googleLabel = text.match(/Google Fonts:\s*([^()\n;]+)/i);
		if (googleLabel) return cleanIgnoreValueDisplay(googleLabel[1]);

		const family = text.match(/font-family\s*:\s*["']?([^'",;\n]+)/i);
		if (family) return cleanIgnoreValueDisplay(family[1]);

		const google = text.match(/[?&]family=([^&:;\n]+)/i);
		if (google) {
			try {
				return cleanIgnoreValueDisplay(decodeURIComponent(google[1]));
			} catch {
				return cleanIgnoreValueDisplay(google[1]);
			}
		}
	}

	return "";
}

/** The value a `bounce-easing` finding is waived by: the utility, the curve, or the name. */
function extractMotionIgnoreValue(text: string): string {
	const tailwind = text.match(/\banimate-bounce\b/i);
	if (tailwind) return cleanIgnoreValueDisplay(tailwind[0]);

	const bezier = text.match(/cubic-bezier\([^)]+\)/i);
	if (bezier) return cleanIgnoreValueDisplay(bezier[0]);

	const animation = text.match(/animation(?:-name)?\s*:\s*([^;\n]+)/i);
	if (animation) {
		const token = animation[1].split(/[,\s]+/).find((part) => /bounce|elastic|wobble|jiggle|spring/i.test(part));
		if (token) return cleanIgnoreValueDisplay(token);
	}

	return "";
}

function cleanIgnoreValueDisplay(value: unknown): string {
	return String(value || "")
		.trim()
		.replace(/^["']|["']$/g, "")
		.replace(/\+/g, " ")
		.replace(/\s+/g, " ");
}

export {
	cleanIgnoreValueDisplay,
	colorIgnoreKey,
	DEFAULT_DETECTION_CONFIG,
	extractFindingIgnoreValue,
	extractMotionIgnoreValue,
	filterDetectionFindings,
	getConfigPath,
	getLocalConfigPath,
	globToRegex,
	ignoreValueMatches,
	matchesAnyGlob,
	normalizeIgnoreRule,
	normalizeIgnoreValue,
	normalizeIgnoreValueEntries,
	readDetectionConfig,
	shouldIgnoreDetectionFile,
	writeDetectionConfig,
};
export type { Rgba };
