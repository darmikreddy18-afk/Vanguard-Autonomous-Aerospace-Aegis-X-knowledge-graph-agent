import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getGraph, closeConnection, GRAPH_NAME } from "../lib/falkordb";

type Row = Record<string, string | number | boolean | null>;

interface SeedData {
  teams: Row[];
  engineers: Row[];
  projects: Row[];
  engineering_docs: Row[];
  jira_tickets: Row[];
  slack_threads: Row[];
  decisions: Row[];
  graph_edges: { source: string; target: string; relationship: string }[];
}

// JSON array -> node label mapping
const NODE_SOURCES: { key: keyof Omit<SeedData, "graph_edges">; label: string }[] = [
  { key: "teams", label: "Team" },
  { key: "engineers", label: "Person" },
  { key: "projects", label: "Project" },
  { key: "engineering_docs", label: "Document" },
  { key: "jira_tickets", label: "Ticket" },
  { key: "slack_threads", label: "SlackThread" },
  { key: "decisions", label: "Decision" },
];

// Labels and relationship types are interpolated into Cypher (they can't be
// parameterized), so they are validated against a strict pattern first.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(value: string, kind: string): string {
  if (!SAFE_IDENT.test(value)) throw new Error(`Unsafe ${kind}: ${value}`);
  return value;
}

/**
 * Every node gets a uniform `name` property so the UI and the LLM can
 * display any node without caring about its label:
 *   Team/Person/Project -> name, Document -> title, Ticket -> key + summary,
 *   SlackThread -> channel + topic.
 */
function withDisplayName(label: string, row: Row): Row {
  switch (label) {
    case "Document":
      return { ...row, name: String(row.title) };
    case "Ticket":
      return { ...row, name: `${row.key}: ${row.summary}` };
    case "SlackThread":
      return { ...row, name: `${row.channel}: ${row.topic}` };
    default:
      return row;
  }
}

async function main() {
  const seedPath = resolve(process.cwd(), "data/seed_data.json");
  const data: SeedData = JSON.parse(readFileSync(seedPath, "utf-8"));
  // Decisions + SUPERSEDES/DECIDED_IN edges live in their own file so the base seed stays untouched.
  const extra = JSON.parse(readFileSync(resolve(process.cwd(), "data/decisions.json"), "utf-8"));
  data.decisions = extra.decisions;
  data.graph_edges.push(...extra.graph_edges);
  const graph = await getGraph();

  console.log(`Seeding graph "${GRAPH_NAME}"...`);

  // 1. Clear existing graph
  await graph.query("MATCH (n) DETACH DELETE n");
  console.log("  cleared existing graph");

  // 2. Nodes
  const idToLabel = new Map<string, string>();
  for (const { key, label } of NODE_SOURCES) {
    assertIdent(label, "label");
    for (const raw of data[key]) {
      const row = withDisplayName(label, raw);
      idToLabel.set(String(row.id), label);
      await graph.query(`CREATE (n:${label}) SET n = $props`, {
        params: { props: row },
      });
    }
    console.log(`  created ${data[key].length} ${label} nodes`);
  }

  // Index `id` on every label so edge MATCHes stay fast.
  for (const { label } of NODE_SOURCES) {
    try {
      await graph.createNodeRangeIndex(label, "id");
    } catch {
      /* index may already exist */
    }
  }

  // 3. Relationships (type kept exactly as written in the JSON)
  let edgeCount = 0;
  for (const edge of data.graph_edges) {
    const type = assertIdent(edge.relationship, "relationship type");
    const srcLabel = idToLabel.get(edge.source);
    const dstLabel = idToLabel.get(edge.target);
    if (!srcLabel || !dstLabel) {
      console.warn(`  skipping edge with unknown endpoint: ${JSON.stringify(edge)}`);
      continue;
    }
    await graph.query(
      `MATCH (a:${srcLabel} {id: $src}), (b:${dstLabel} {id: $dst})
       CREATE (a)-[:${type}]->(b)`,
      { params: { src: edge.source, dst: edge.target } }
    );
    edgeCount++;
  }
  console.log(`  created ${edgeCount} relationships`);

  const check = await graph.roQuery<{ nodes: number }>("MATCH (n) RETURN count(n) AS nodes");
  const checkE = await graph.roQuery<{ edges: number }>("MATCH ()-[r]->() RETURN count(r) AS edges");
  console.log(
    `Done. Graph now has ${check.data?.[0]?.nodes} nodes and ${checkE.data?.[0]?.edges} edges.`
  );
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(closeConnection);
