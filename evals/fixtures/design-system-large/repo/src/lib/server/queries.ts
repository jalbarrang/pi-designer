import { allEvents } from "./db.ts";

/** Requests per day for the last `days` days, oldest first. */
export function dailyRequests(days: number): number[] {
	const counts = new Map<string, number>();
	for (const event of allEvents()) {
		if (event.kind !== "request") continue;
		const day = event.at.slice(0, 10);
		counts.set(day, (counts.get(day) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.slice(-days)
		.map(([, count]) => count);
}

/** Error rate over the whole store. */
export function errorRate(): number {
	const events = allEvents();
	if (events.length === 0) return 0;
	const errors = events.filter((event) => event.kind === "error").length;
	return errors / events.length;
}
