import { runTriage } from "../lib/triage/worker.ts";
const r = await runTriage(20);
console.log("claimed:", r.claimed, " routed:", r.routed, " failed:", r.failed, " unstaffed:", r.unstaffed);
