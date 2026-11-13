/** In-memory store. Seeded by scripts/seed.ts, replaced by a real database later. */
export type Event = { id: string; at: string; kind: "request" | "error" };

const events: Event[] = [];

export function seed(input: { events: number }): void {
	events.length = 0;
	const base = Date.parse("2026-01-01T00:00:00Z");
	for (let index = 0; index < input.events; index += 1) {
		events.push({
			id: `e-${index}`,
			at: new Date(base + index * 60_000).toISOString(),
			kind: index % 250 === 0 ? "error" : "request",
		});
	}
}

export function allEvents(): readonly Event[] {
	return events;
}
