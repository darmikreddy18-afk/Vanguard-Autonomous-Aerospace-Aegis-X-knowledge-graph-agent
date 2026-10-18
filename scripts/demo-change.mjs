// Applies the two demo "newer facts" to a running app (needs DEMO_INGEST=1 in .env.local).
// Re-ask the same questions afterwards: the answers change and cite the SUPERSEDES chain.
// Reset to baseline with `npm run seed` (then wait SNAPSHOT_TTL_MS or restart the dev server).
const base = process.env.APP_URL ?? "http://localhost:3000";
const post = async (body) => {
  const res = await fetch(`${base}/api/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  console.log(res.status, JSON.stringify(await res.json()));
  if (!res.ok) process.exitCode = 1;
};
// 1) Decision overridden: 180°C limit (dec_02) is superseded by a new decision sourced from ticket AER-408.
await post({
  event: "decision_superseded",
  oldId: "dec_02",
  newId: "dec_03",
  name: "Decision: ESC relay thermal cutoff limit raised to 190°C under FAA waiver",
  statement: "ESC relay thermal cutoff limit is 190°C under an FAA waiver after the heat sink redesign (AER-408).",
  sourceId: "ticket_07",
  byId: "person_05",
});
// 2) Owner changed: ESC Power Relay Unit moves from Sushma Patel (person_06) to Tomás Herrera (person_12).
await post({ event: "owner_changed", id: "proj_02", newOwnerId: "person_12" });
