import { NextResponse } from "next/server";
import { getGraph } from "@/lib/falkordb";
import { invalidateSnapshot } from "@/lib/graph-snapshot";
import { isoNow } from "@/lib/intent";
import { EVENT_CHANGE_OWNER, EVENT_SUPERSEDE_DECISION } from "@/lib/queries";

/**
 * POST /api/ingest : the "newer fact arrives" path.
 *   { event: "decision_superseded", oldId, newId, name, statement, sourceId, byId, at? }
 *   { event: "owner_changed", id, newOwnerId, at? }
 * Writes are parameterised Cypher. Old facts are never deleted: decisions are marked 'superseded'
 * (valid_to set, SUPERSEDES edge added), replaced owners become PREVIOUSLY_OWNED.
 * Disabled unless DEMO_INGEST=1 so a public deployment cannot be mutated by strangers.
 */
const ID = /^[a-z]+_[a-z0-9_]+$/i;
const str = (v: unknown, max = 300) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
const id = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : null);

export async function POST(req: Request) {
  if (process.env.DEMO_INGEST !== "1") return NextResponse.json({ error: "Ingest is disabled. Set DEMO_INGEST=1." }, { status: 403 });
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const at = str(b.at, 30) ?? isoNow();

  try {
    const graph = await getGraph();
    if (b.event === "decision_superseded") {
      const p = { oldId: id(b.oldId), newId: id(b.newId), name: str(b.name), statement: str(b.statement, 500), sourceId: id(b.sourceId), byId: id(b.byId), at };
      if (Object.values(p).some((v) => v === null)) return NextResponse.json({ error: "oldId, newId, name, statement, sourceId, byId are required." }, { status: 400 });
      const res = await graph.query<Record<string, unknown>>(EVENT_SUPERSEDE_DECISION, { params: p as Record<string, string> });
      if (!res.data?.length) return NextResponse.json({ error: "Nothing changed: oldId must be an ACTIVE decision that CONCERNS something, and sourceId/byId must exist." }, { status: 409 });
      invalidateSnapshot();
      return NextResponse.json({ ok: true, applied: res.data[0] });
    }
    if (b.event === "owner_changed") {
      const p = { id: id(b.id), newOwnerId: id(b.newOwnerId), at };
      if (Object.values(p).some((v) => v === null)) return NextResponse.json({ error: "id and newOwnerId are required." }, { status: 400 });
      const res = await graph.query<Record<string, unknown>>(EVENT_CHANGE_OWNER, { params: p as Record<string, string> });
      if (!res.data?.length) return NextResponse.json({ error: "Nothing changed: id must currently have an owner other than newOwnerId." }, { status: 409 });
      invalidateSnapshot();
      return NextResponse.json({ ok: true, applied: res.data[0] });
    }
    return NextResponse.json({ error: "event must be 'decision_superseded' or 'owner_changed'." }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: /ECONNREFUSED|connect/i.test(message) ? 503 : 500 });
  }
}
