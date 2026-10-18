import { NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";
import { getGraph } from "@/lib/falkordb";
import { GRAPH_SCHEMA_PROMPT } from "@/lib/graph-schema";
import { assertReadOnly, cleanCypher } from "@/lib/cypher-guard";
import { extractGraphData, type GraphData } from "@/lib/graph-extract";
import { loadSnapshot, serializeSnapshot, SNAPSHOT_CYPHER, type Snapshot } from "@/lib/graph-snapshot";
import { buildHints } from "@/lib/entity-link";
import { REFUSAL, checkGrounding, isRefusal } from "@/lib/grounding";
import { parseExecMs } from "@/lib/path-query";
import { routeIntent, runRoute, type Route } from "@/lib/intent";

// gemini-2.5-* models were retired in Oct 2026; 3.1 Flash-Lite is stable and has a free tier.
// Override with GEMINI_MODEL in .env.local (e.g. a newer Flash model).
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const MAX_PROMPT_CHARS = 2000;
// Whole graph goes into the prompt while it is at most this big (~17k tokens). Bigger graphs
// automatically switch to Text-to-Cypher retrieval.
const MAX_FULL_GRAPH_CHARS = Number(process.env.MAX_FULL_GRAPH_CHARS ?? 60000);
const MAX_GRAPH_CHARS_FOR_LLM = 24000;

const CYPHER_SYSTEM_PROMPT =
  "You are a strict FalkorDB Cypher generator. You must ONLY use the exact Node Labels, Properties, and Relationship Types provided in the schema. Do not invent edges. Do not hallucinate properties. Return ONLY valid Cypher code inside a ```cypher block.";

const ANSWER_SYSTEM_PROMPT =
  'You are the Vanguard Aerospace Context Engine. You are strictly forbidden from using outside knowledge. You must formulate your answer SOLELY based on the provided JSON graph data retrieved from FalkorDB. If the provided graph data does not contain the answer, you must reply: "I cannot answer this based on the current Vanguard knowledge graph." Do not speculate.';

const FULL_GRAPH_FORMAT = `
The data was read live from FalkorDB. The user message contains QUESTION, HINTS, NODES and EDGES.
- NODES lines look like: id | Label | property=value; ... Properties ending in _id point to other nodes (their name is shown in parentheses).
- EDGES lines look like: source (name) -[RELATIONSHIP]-> target (name).

How to answer:
- Give the direct answer first, then explain the reasoning by walking the specific relationships and properties you used, citing node ids, names or keys, and relationship types exactly as written in the data.
- For multi-hop questions follow the EDGES step by step. Answer every part of a multi-part question.
- Never state a name, key, id, number, date or relationship that is not literally in the data.
- Plain text only, no markdown.

Output JSON with two fields:
- "answer": your answer text, or exactly the refusal sentence if the data does not contain the answer.
- "evidence_node_ids": the ids of every node your answer relies on (an empty array if you refused).`;

let _ai: GoogleGenAI | undefined;
function ai() {
  // Lazy: reads GEMINI_API_KEY on first request, not at import/build time.
  return (_ai ??= new GoogleGenAI({}));
}

type Msg = { role: "user" | "assistant"; content: string };

async function complete(
  system: string,
  messages: Msg[],
  maxTokens: number,
  json?: { answer: boolean }
): Promise<string> {
  const res = await ai().models.generateContent({
    model: MODEL,
    // Gemini uses the "model" role where other APIs use "assistant".
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    config: {
      systemInstruction: system,
      temperature: 0, // deterministic output: no creative drift
      maxOutputTokens: maxTokens,
      ...(json && {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: { type: Type.STRING },
            evidence_node_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["answer", "evidence_node_ids"],
        },
      }),
    },
  });
  const text = (res.text ?? "").trim();
  if (!text) {
    // Surface this instead of letting it look like a "not in the graph" answer.
    const reason = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? "unknown";
    throw new Error(`Gemini returned an empty response (reason: ${reason}). Try asking again.`);
  }
  return text;
}

function parseAnswerJson(raw: string): { answer: string; ids: string[] } {
  const body = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let obj: { answer?: unknown; evidence_node_ids?: unknown };
  try {
    obj = JSON.parse(body);
  } catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("The model did not return the expected JSON answer. Try asking again.");
    obj = JSON.parse(m[0]);
  }
  const ids = Array.isArray(obj.evidence_node_ids) ? obj.evidence_node_ids.map(String) : [];
  return { answer: String(obj.answer ?? "").trim(), ids };
}

/** The nodes the answer relies on, plus every real edge between them. */
function evidenceGraph(snap: Snapshot, ids: Iterable<string>): GraphData {
  const keep = new Set([...ids].filter((id) => snap.byId.has(id)));
  const nodes = [...keep].map((id) => {
    const n = snap.byId.get(id)!;
    return { ...n.props, id, label: n.label, name: String(n.props.name ?? n.display) };
  });
  const links = snap.edges
    .filter((e) => keep.has(e.source) && keep.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, type: e.type }));
  return { nodes, links };
}

/** Mode 1: the whole live graph is the context. Nothing can be "missed" by a bad query. */
async function answerFromFullGraph(question: string, snap: Snapshot, context: string) {
  const system = `${ANSWER_SYSTEM_PROMPT}\n${FULL_GRAPH_FORMAT}`;
  const userMsg = `QUESTION:\n${question}\n\n${buildHints(question, snap)}\n\n${context}`;
  const messages: Msg[] = [{ role: "user", content: userMsg }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await complete(system, messages, 8192, { answer: true });
    const { answer, ids } = parseAnswerJson(raw);

    if (!answer || isRefusal(answer)) return { textAnswer: REFUSAL, graphData: evidenceGraph(snap, []), refused: true };

    // Ids cited by the model that really exist, plus any ids written in the answer itself.
    const inText = (answer.match(/\b(?:team|person|proj|doc|ticket|slack|dec)_[a-z0-9_]+\b/gi) ?? []).map((s) => s.toLowerCase());
    const valid = [...new Set([...ids, ...inText].filter((id) => snap.byId.has(id)))];

    const problems = checkGrounding(answer, question, context, valid.length);
    if (problems.length === 0) return { textAnswer: answer, graphData: evidenceGraph(snap, valid), refused: false };

    console.warn("[/api/chat] ungrounded answer, attempt", attempt + 1, problems);
    messages.push(
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `Your answer was rejected by a fact-check against the data:\n- ${problems.join("\n- ")}\nRewrite it using ONLY facts literally present in the data and cite the real node ids in evidence_node_ids. If the data does not contain the answer, use the refusal sentence.`,
      }
    );
  }
  // Never return an answer that failed the fact-check.
  return { textAnswer: REFUSAL, graphData: evidenceGraph(snap, []), refused: true };
}


const ROW_FORMAT = `
The data below are the ROWS returned by a Cypher traversal of FalkorDB (query intent: %INTENT%). The user message contains QUESTION and ROWS (JSON).
- Answer ONLY from ROWS. Give the direct answer first, then the supporting path or chain, citing node ids, names or keys exactly as written.
- Decisions have a status. Lead with the 'active' one. For any 'superseded' decision say what superseded it (superseded_by_id / supersedes_id) and the valid_to date.
- If the rows show an owner that was replaced (prev_owner), say who owns it now, who owned it before, and since when.
- For provenance, walk chain_names in order using chain_rels (e.g. decision -DECIDED_IN-> thread -DISCUSSES-> ticket).
- Never state a name, key, id, number or date that is not literally in ROWS. Plain text only, no markdown.
Output JSON with two fields: "answer" and "evidence_node_ids" (ids of nodes your answer relies on, [] if you refused).`;

const ID_ONLY = /^(?:team|person|proj|doc|ticket|slack|dec)_[a-z0-9_]+$/i;

/** Every node id that appears anywhere in the returned rows (including list-valued columns). Deterministic, not LLM-declared. */
function idsInRows(rows: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") { if (ID_ONLY.test(v)) out.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(rows);
  return [...out];
}

/** Mode 0 (default for the questions the product is built around): a named Cypher traversal answers; the LLM only phrases the rows. */
async function answerFromRoute(question: string, snap: Snapshot, route: Route) {
  const { rows: raw, executionMs } = await runRoute(route);
  if (raw.length === 0) return null; // nothing in the graph: let the caller fall back
  // "what changed" can be long: newest first, capped.
  const rows = route.intent === "changes" ? [...raw].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 40) : raw.slice(0, 60);
  const context = JSON.stringify(rows);
  const system = `${ANSWER_SYSTEM_PROMPT}\n${ROW_FORMAT.replace("%INTENT%", route.intent)}`;
  const messages: Msg[] = [{ role: "user", content: `QUESTION:\n${question}\n\nROWS:\n${context}` }];
  const evidence = idsInRows(rows).filter((id) => snap.byId.has(id));

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await complete(system, messages, 8192, { answer: true });
    const { answer } = parseAnswerJson(raw);
    if (!answer || isRefusal(answer)) return null;
    const problems = checkGrounding(answer, question, context, evidence.length);
    if (problems.length === 0) {
      const cypher = `${route.resolvedBy ? `${route.resolvedBy}\n` : ""}${route.cypher}\n// params: ${JSON.stringify(route.params)}`;
      return { textAnswer: answer, graphData: evidenceGraph(snap, evidence), refused: false, executionMs, cypher };
    }
    console.warn("[/api/chat] ungrounded route answer", attempt + 1, problems);
    messages.push(
      { role: "assistant", content: raw },
      { role: "user", content: `Your answer failed a fact-check against ROWS:\n- ${problems.join("\n- ")}\nRewrite using ONLY facts literally in ROWS.` }
    );
  }
  return null;
}

/** Mode 2 (graphs too big for one prompt): LLM writes Cypher, we answer from what it returns. */
async function generateAndRun(prompt: string) {
  const graph = await getGraph();
  const system = `${CYPHER_SYSTEM_PROMPT}\n\n${GRAPH_SCHEMA_PROMPT}`;
  const messages: Msg[] = [{ role: "user", content: prompt }];
  let lastError = "";
  let emptyResult: { cypher: string; rows: Record<string, unknown>[] } | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await complete(system, messages, 8192);
    const cypher = cleanCypher(raw);
    try {
      assertReadOnly(cypher);
      const result = await graph.roQuery<Record<string, unknown>>(cypher);
      const rows = result.data ?? [];
      // Valid query but nothing came back: usually wrong direction or property.
      if (rows.length === 0 && attempt === 0) {
        emptyResult = { cypher, rows };
        messages.push(
          { role: "assistant", content: raw },
          {
            role: "user",
            content:
              "That query was valid but returned no rows. The relationship direction or a property filter is probably wrong. Rewrite it more broadly using only the schema: drop arrow directions, match entities by key or id, and use variable-length paths. Return it inside a ```cypher block.",
          }
        );
        continue;
      }
      return { cypher, rows };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `That query failed: ${lastError}\nReturn a corrected read-only query using only the schema, inside a \`\`\`cypher block.`,
        }
      );
    }
  }
  if (emptyResult) return emptyResult;
  throw new Error(`Could not produce a valid Cypher query: ${lastError}`);
}

async function answerViaCypher(question: string) {
  const { cypher, rows } = await generateAndRun(question);
  const graphData = await extractGraphData(rows);
  if (rows.length === 0) return { textAnswer: REFUSAL, graphData, cypher, refused: true };

  const evidence = graphData.nodes.length > 0 ? graphData : { rows };
  let payload = JSON.stringify(evidence);
  if (payload.length > MAX_GRAPH_CHARS_FOR_LLM) payload = payload.slice(0, MAX_GRAPH_CHARS_FOR_LLM) + " ...[truncated]";
  const textAnswer = await complete(
    ANSWER_SYSTEM_PROMPT,
    [{ role: "user", content: `Question: ${question}\n\nData retrieved from FalkorDB (JSON):\n${payload}` }],
    8192
  );
  const problems = checkGrounding(textAnswer, question, payload, 1);
  if (problems.length) {
    console.warn("[/api/chat] ungrounded cypher-mode answer", problems);
    return { textAnswer: REFUSAL, graphData, cypher, refused: true };
  }
  return { textAnswer, graphData, cypher, refused: isRefusal(textAnswer) };
}

const NEIGHBOR_CYPHER = "MATCH (s)-[]-(c) WHERE s.id IN $ids RETURN DISTINCT c.id AS id";

/** 1-hop neighbours of the answer's nodes, fetched from FalkorDB so the UI can keep them in view. */
async function neighborsOf(ids: string[]): Promise<{ neighborIds: string[]; executionMs: number | null }> {
  if (ids.length === 0) return { neighborIds: [], executionMs: null };
  try {
    const graph = await getGraph();
    const t0 = performance.now();
    const res = await graph.roQuery<{ id: string }>(NEIGHBOR_CYPHER, { params: { ids } });
    const executionMs = parseExecMs(res.metadata, performance.now() - t0);
    const own = new Set(ids);
    return { neighborIds: [...new Set((res.data ?? []).map((r) => r.id))].filter((id) => !own.has(id)), executionMs };
  } catch {
    return { neighborIds: [], executionMs: null };
  }
}

export async function POST(req: Request) {
  let prompt: unknown;
  try {
    ({ prompt } = await req.json());
  } catch {
    return NextResponse.json({ error: "Body must be JSON: { prompt: string }" }, { status: 400 });
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json({ error: "`prompt` must be a non-empty string." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json({ error: `Prompt exceeds ${MAX_PROMPT_CHARS} characters.` }, { status: 400 });
  }
  const question = prompt.trim();

  try {
    const snap = await loadSnapshot();

    // Mode 0: named Cypher traversal (owner / who-knows / provenance / history / changes / dependency owners).
    const route = await routeIntent(question, snap);
    if (route) {
      const r = await answerFromRoute(question, snap, route);
      if (r) {
        const { neighborIds } = await neighborsOf(r.graphData.nodes.map((n) => n.id));
        return NextResponse.json({ ...r, neighborIds, retrieval: `cypher:${route.intent}` });
      }
    }

    const context = serializeSnapshot(snap);

    if (context.length <= MAX_FULL_GRAPH_CHARS) {
      const r = await answerFromFullGraph(question, snap, context);
      const { neighborIds, executionMs } = await neighborsOf(r.graphData.nodes.map((n) => n.id));
      return NextResponse.json({ ...r, neighborIds, executionMs, cypher: `${SNAPSHOT_CYPHER}\n${NEIGHBOR_CYPHER}`, retrieval: "full-graph" });
    }
    const r = await answerViaCypher(question);
    const { neighborIds, executionMs } = await neighborsOf(r.graphData.nodes.map((n) => n.id));
    return NextResponse.json({ ...r, neighborIds, executionMs, cypher: `${r.cypher}\n${NEIGHBOR_CYPHER}`, retrieval: "cypher" });
  } catch (err) {
    console.error("[/api/chat]", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = /ECONNREFUSED|connect/i.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
