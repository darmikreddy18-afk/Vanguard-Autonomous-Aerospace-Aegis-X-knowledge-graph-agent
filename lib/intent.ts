import { getGraph } from "./falkordb";
import { linkEntities } from "./entity-link";
import type { Snapshot } from "./graph-snapshot";
import { parseExecMs } from "./path-query";
import { ACTIVE_DECISION_FOR, QUERIES, type Intent } from "./queries";

export interface Route {
  intent: Intent;
  label: string;
  /** The query that is actually executed. */
  cypher: string;
  params: Record<string, string>;
  /** Optional first query that resolved the anchor (shown in the UI alongside `cypher`). */
  resolvedBy?: string;
}

/** ISO-8601 with seconds and a Z, the same shape stored in the graph, so string comparison orders correctly. */
export const isoNow = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function sinceFrom(q: string, now: Date): string {
  const n = /(\d+)\s*days?/.exec(q);
  const days = n ? Number(n[1]) : /yesterday|today|last 24/.test(q) ? 1 : /month/.test(q) ? 30 : 7;
  return isoNow(new Date(now.getTime() - days * 864e5));
}

/**
 * Deterministic intent router. Order matters: the first match wins.
 * Anything it does not recognise returns null and the caller falls back to full-graph mode.
 */
export function classify(q: string): Intent | null {
  const s = q.toLowerCase();
  if (/\b(what('s| has| have)? (changed|new)|what changed|changes? (since|in)|since (last|yesterday|\d)|last (week|month)|this week|recent(ly)? (changed|updated|decid))/.test(s)) return "changes";
  if (/\b(supersed|history|previously|used to|no longer|reversed|reversal|replaced|overrid|overridden)/.test(s)) return "history";
  if (/\b(why|rationale|reason|decided|decision|where (did|does).*(come|originate)|provenance|source of)\b/.test(s)) return "provenance";
  if (/\b(depends? on|dependenc|upstream)\b/.test(s)) return "dependency_owners";
  if (/\bwho (knows|understands|has worked|worked|can (help|explain)|should i (ask|talk))|\b(expert|familiar with)\b/.test(s)) return "who_knows";
  if (/\bwho (owns|is (the )?owner|is responsible|maintains|is accountable|is in charge)|\bowner of\b/.test(s)) return "owner";
  return null;
}

/** Pick the strongest entity in the question whose label fits the query. */
function anchorFor(question: string, snap: Snapshot, allowed: string[]): string | null {
  for (const a of linkEntities(question, snap, 12)) {
    const n = snap.byId.get(a.id);
    if (n && allowed.includes(n.label)) return n.id;
  }
  return null;
}

export async function routeIntent(question: string, snap: Snapshot, now = new Date()): Promise<Route | null> {
  const intent = classify(question);
  if (!intent) return null;
  const q = QUERIES[intent];

  if (q.anchors === null) return { intent, label: q.label, cypher: q.cypher, params: { since: sinceFrom(question.toLowerCase(), now) } };

  // Provenance can be asked about a decision or about the thing it concerns ("why is the relay limit 180°C?").
  if (intent === "provenance") {
    const subject = anchorFor(question, snap, ["Decision", "Project", "Document"]);
    if (!subject) return null;
    if (snap.byId.get(subject)!.label === "Decision") return { intent, label: q.label, cypher: q.cypher, params: { id: subject } };
    const graph = await getGraph();
    const res = await graph.roQuery<{ id: string }>(ACTIVE_DECISION_FOR, { params: { id: subject } });
    const id = res.data?.[0]?.id;
    return id ? { intent, label: q.label, cypher: q.cypher, params: { id }, resolvedBy: ACTIVE_DECISION_FOR } : null;
  }

  const id = anchorFor(question, snap, q.anchors);
  return id ? { intent, label: q.label, cypher: q.cypher, params: { id } } : null;
}

export async function runRoute(route: Route): Promise<{ rows: Record<string, unknown>[]; executionMs: number }> {
  const graph = await getGraph();
  const t0 = performance.now();
  const res = await graph.roQuery<Record<string, unknown>>(route.cypher, { params: route.params });
  return { rows: res.data ?? [], executionMs: parseExecMs(res.metadata, performance.now() - t0) };
}
