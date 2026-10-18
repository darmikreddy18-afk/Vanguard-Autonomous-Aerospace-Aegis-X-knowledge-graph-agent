// No-LLM smoke test: does each question route to the intended Cypher traversal, and does it return rows?
// Needs FalkorDB running and seeded (`npm run setup`). Run: npm run check:routes
import { closeConnection } from "../lib/falkordb";
import { loadSnapshot } from "../lib/graph-snapshot";
import { routeIntent, runRoute } from "../lib/intent";

// [question, expected intent (null = must fall back to full-graph mode), expected anchor id]
const CASES: [string, string | null, string | null][] = [
  ["Who owns the ESC Power Relay Unit?", "owner", "proj_02"],
  ["Who owns the FAA Rule 107-B Thermal Safety Directive?", "owner", "doc_02"],
  [
    "Who is responsible for the LiDAR Obstacle Avoidance Pipeline?",
    "owner",
    "proj_04",
  ],
  ["Who knows about the ESC Power Relay Unit?", "who_knows", "proj_02"],
  ["Who knows about AER-402?", "who_knows", "ticket_01"],
  [
    "Why was the ESC relay thermal cutoff limit lowered to 180°C, and where does it come from?",
    "provenance",
    "dec_02",
  ],
  ["Why is the ESC Power Relay Unit limit what it is?", "provenance", "dec_02"],
  [
    "Has the thermal limit for the ESC Power Relay Unit been superseded?",
    "history",
    "proj_02",
  ],
  ["What changed since last week?", "changes", null],
  [
    "Who owns the projects that the Q3 Commercial Delivery Pilot depends on?",
    "dependency_owners",
    "proj_06",
  ],
  [
    "What is the downstream impact of the ESC Relay 3 overheating on the Q3 pilot?",
    null,
    null,
  ],
  ["Which P1-Critical tickets are still open or in progress?", null, null],
];

async function main() {
  const snap = await loadSnapshot();
  let fail = 0;
  for (const [q, wantIntent, wantAnchor] of CASES) {
    const route = await routeIntent(q, snap);
    const gotIntent = route?.intent ?? null;
    const gotAnchor =
      route?.intent === "provenance" || route?.params.id
        ? (route?.params.id ?? null)
        : null;
    let rows = 0;
    if (route) rows = (await runRoute(route)).rows.length;
    const ok =
      gotIntent === wantIntent &&
      (wantAnchor === null || gotAnchor === wantAnchor) &&
      (wantIntent === null || rows > 0);
    if (!ok) fail++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${(gotIntent ?? "fallback:full-graph").padEnd(18)} anchor=${String(gotAnchor).padEnd(10)} rows=${String(rows).padEnd(3)} | ${q}`,
    );
  }
  console.log(fail ? `\n${fail} case(s) failed` : "\nAll routes OK");
  await closeConnection();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
