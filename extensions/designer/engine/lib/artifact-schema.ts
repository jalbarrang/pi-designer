/**
 * Schema versions for the artifacts the engine writes, plus the readers and writers for the
 * PRODUCT.md provenance stamp. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Schema versions rather than release versions, deliberately: a PRODUCT.md written by an
 * older release is not stale under a patch release, so stamping the version would mark every
 * artifact old on every bump. A schema version changes only when the shape does, which is
 * exactly when a migration is owed.
 *
 * DESIGN.md carries no stamp on purpose: it follows the external design.md spec that a
 * linter validates, and an extra frontmatter key risks failing that lint for nothing. Every
 * staleness signal it needs (sidecar version, sidecar mtime, section coverage, git drift) is
 * measurable without one.
 */

/** PRODUCT.md as the init flow writes it today: the ten-section v4 record. */
const PRODUCT_SCHEMA_VERSION = 1;

/** `.impeccable/design.json`, as documented in the document reference. */
const DESIGN_SIDECAR_SCHEMA_VERSION = 2;

/**
 * Sections the v4 record added. A PRODUCT.md carrying none of them and no stamp predates
 * the current record; an explicit stamp always wins over this fallback.
 */
const PRODUCT_V4_SECTIONS: readonly string[] = Object.freeze([
	"Positioning",
	"Operating Context",
	"Evidence on Hand",
	"Product Principles",
]);

/**
 * Headings the engine used to read and no longer does, with the reason.
 *
 * The reason matters: told only that a field is deprecated, an agent tends to keep it "just
 * in case", which is how a retired axis keeps steering current output.
 */
const PRODUCT_DEPRECATED_SECTIONS: Readonly<Record<string, string>> = Object.freeze({
	Register:
		"v4 replaced the brand/product register axis with the four visitor modes (Persuade, Operate, Read, Experience), which are chosen per surface and persisted in that surface's brief. Nothing reads `## Register` any more.",
});

const PRODUCT_STAMP_RE = /^[ \t]*<!--[ \t]*impeccable:product-schema[ \t]+(\d+)[ \t]*-->[ \t]*$/im;

/** The literal stamp line, for a template and for migrations. */
function productStampLine(version: number = PRODUCT_SCHEMA_VERSION): string {
	return `<!-- impeccable:product-schema ${version} -->`;
}

/**
 * The schema version stamped in a PRODUCT.md body, or null when unstamped. Null means
 * "written before stamping existed", not "invalid".
 */
function readProductSchemaVersion(markdown: string | null | undefined): number | null {
	const match = String(markdown || "").match(PRODUCT_STAMP_RE);
	if (!match) return null;
	const version = Number.parseInt(match[1], 10);
	return Number.isInteger(version) ? version : null;
}

/**
 * Add or update the stamp and return the new body. Idempotent, and it never reorders prose: a
 * stamped file keeps the stamp where it already sits, and an unstamped one gets it directly
 * under the leading `#` heading, or at the top when there is none.
 */
function stampProductSchema(markdown: string | null | undefined, version: number = PRODUCT_SCHEMA_VERSION): string {
	const body = String(markdown || "");
	const line = productStampLine(version);
	if (PRODUCT_STAMP_RE.test(body)) return body.replace(PRODUCT_STAMP_RE, line);

	const lines = body.split("\n");
	const headingIndex = lines.findIndex((entry) => /^#\s+\S/.test(entry));
	if (headingIndex === -1) return `${line}\n\n${body.replace(/^\n+/, "")}`;
	lines.splice(headingIndex + 1, 0, "", line);
	return lines.join("\n");
}

/**
 * The schema version of a parsed `design.json`, or null for a missing or non-numeric field.
 * Null is how schema-version-1-era sidecars present: the field predates the v2 rewrite.
 */
function readSidecarSchemaVersion(sidecar: unknown): number | null {
	const version = sidecar && typeof sidecar === "object" ? (sidecar as { schemaVersion?: unknown }).schemaVersion : null;
	return typeof version === "number" && Number.isInteger(version) ? version : null;
}

export {
	DESIGN_SIDECAR_SCHEMA_VERSION,
	PRODUCT_DEPRECATED_SECTIONS,
	PRODUCT_SCHEMA_VERSION,
	PRODUCT_V4_SECTIONS,
	productStampLine,
	readProductSchemaVersion,
	readSidecarSchemaVersion,
	stampProductSchema,
};
