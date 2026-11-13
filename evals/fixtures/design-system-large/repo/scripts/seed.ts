/** Fill the in-memory store with deterministic sample data. */
import { seed } from "../src/lib/server/db.ts";

const events = Number(process.argv.find((arg) => arg.startsWith("--events="))?.split("=")[1] ?? 500);

seed({ events });
console.log(`seeded ${events} events`);
