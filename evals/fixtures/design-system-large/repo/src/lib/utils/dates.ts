/** "2026-03-04" in UTC, stable across timezones. */
export function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Days between two dates, rounded down. */
export function daysBetween(from: Date, to: Date): number {
	return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
