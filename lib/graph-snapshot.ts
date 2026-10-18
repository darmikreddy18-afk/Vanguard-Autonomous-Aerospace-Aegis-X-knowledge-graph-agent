import { getGraph } from "./falkordb";

export interface SnapNode {
  id: string;
  label: string;
  props: Record<string, unknown>;
  /** Short human label: ticket key, Slack channel, document title or name. */
  display: string;
}
export interface SnapEdge {
  source: string;
  target: string;
  type: string;
}
export interface Snapshot {
  nodes: SnapNode[];
  edges: SnapEdge[];
  byId: Map<string, SnapNode>;
}

export const SNAPSHOT_CYPHER = [
  "MATCH (n) RETURN n",
  "MATCH (a)-[r]->(b) RETURN a.id AS source, type(r) AS type, b.id AS target",
].join("\n");

const TTL_MS = Number(process.env.SNAPSHOT_TTL_MS ?? 30_000);
const cache = globalThis as unknown as { __vanguardSnap?: { at: number; snap: Snapshot } };

/** Drop the cached snapshot so the next read sees facts that were just written. */
export function invalidateSnapshot(): void {
  delete cache.__vanguardSnap;
}

export function displayOf(label: string, p: Record<string, unknown>): string {
  const v =
    label === "Ticket" ? p.key : label === "SlackThread" ? p.channel : label === "Document" ? p.title : p.name;
  return String(v ?? p.name ?? p.id ?? "?");
}

/** Reads the whole graph from FalkorDB (cached for 30s so bursts of questions stay cheap). */
export async function loadSnapshot(): Promise<Snapshot> {
  const hit = cache.__vanguardSnap;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.snap;

  const graph = await getGraph();
  const n = await graph.roQuery<{ n: { labels: string[]; properties: Record<string, unknown> } }>(
    "MATCH (n) RETURN n"
  );
  const e = await graph.roQuery<SnapEdge>(
    "MATCH (a)-[r]->(b) RETURN a.id AS source, type(r) AS type, b.id AS target"
  );

  const nodes: SnapNode[] = (n.data ?? [])
    .map((r) => {
      const label = r.n.labels[0] ?? "Unknown";
      const props = r.n.properties;
      return { id: String(props.id), label, props, display: displayOf(label, props) };
    })
    .filter((x) => x.id && x.id !== "undefined");
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const edges = (e.data ?? []).filter((x) => byId.has(x.source) && byId.has(x.target));

  const snap = { nodes, edges, byId };
  cache.__vanguardSnap = { at: Date.now(), snap };
  return snap;
}

const DERIVED_NAME_LABELS = new Set(["Document", "Ticket", "SlackThread"]);

/** Compact text form of the whole graph: one line per node, one line per edge. */
export function serializeSnapshot(snap: Snapshot): string {
  const clean = (v: unknown) => String(v).replace(/\s+/g, " ").trim();
  const nodeLines = snap.nodes.map((n) => {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(n.props)) {
      if (k === "id" || v === null || v === undefined) continue;
      if (k === "name" && DERIVED_NAME_LABELS.has(n.label)) continue; // duplicate of key/title/channel
      let val = clean(v);
      // Properties like author_id / team_id point at other nodes: show who they are.
      if (k.endsWith("_id") && snap.byId.has(val)) val = `${val} (${snap.byId.get(val)!.display})`;
      parts.push(`${k}=${val}`);
    }
    return `${n.id} | ${n.label} | ${parts.join("; ")}`;
  });
  const edgeLines = snap.edges.map(
    (e) =>
      `${e.source} (${snap.byId.get(e.source)!.display}) -[${e.type}]-> ${e.target} (${snap.byId.get(e.target)!.display})`
  );
  return `NODES (id | label | properties):\n${nodeLines.join("\n")}\n\nEDGES (source -[RELATIONSHIP]-> target):\n${edgeLines.join("\n")}`;
}
