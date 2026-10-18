# Supersession + Cypher-routing patch (drop-in)

Copy the contents of this folder over your repo (same relative paths). Then:

    npm ci && npm run setup && npm run check:routes && npm run build

Changed files:  scripts/seed.ts, lib/graph-snapshot.ts, lib/grounding.ts, lib/graph-style.ts,
                lib/graph-schema.ts, app/api/chat/route.ts, package.json, .env.example, .gitignore, README.md
New files:      data/decisions.json, lib/queries.ts, lib/intent.ts, app/api/ingest/route.ts,
                scripts/demo-change.mjs, scripts/route-check.ts

Tested against a real FalkorDB engine: seed (102 nodes / 170 edges), 12-question routing check, build, lint,
ingest events over HTTP (apply, replay -> 409, injection attempt -> 400, cache invalidation).
NOT tested: calls to Gemini (no network/key in the test environment). Run each headline question once with your key.
