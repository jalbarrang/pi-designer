/** USD by default; no symbol for table alignment. */
export function money(value: number, currency = "USD"): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency,
		maximumFractionDigits: 0,
	}).format(value);
}
