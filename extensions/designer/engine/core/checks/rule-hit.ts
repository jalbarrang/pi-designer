/**
 * What a check returns. Rules report a catalog id and the line that will become
 * the finding's snippet; the scan layer stamps name, description, severity, and
 * file from the catalog, so a check never restates them.
 */
export interface RuleHit {
	/** Catalog rule id, as declared in `registry/antipatterns.ts`. */
	readonly id: string;
	/** Human-readable evidence for the report: the values that tripped the rule. */
	readonly snippet: string;
}
