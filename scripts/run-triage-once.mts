import { runTriage } from "../lib/triage/worker.ts";
const r = await runTriage(20);
console.log(JSON.stringify(r));
