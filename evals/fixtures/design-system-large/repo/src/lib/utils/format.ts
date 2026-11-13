/** Compact number for table cells: 1200 -> 1.2k. */
export function compact(value: number): string {
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1)}k`;
}

/** Percent with one decimal, no sign: 0.042 -> "4.2%". */
export function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}
