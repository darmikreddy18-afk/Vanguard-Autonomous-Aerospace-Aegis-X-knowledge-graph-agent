export const REFUSAL = "I cannot answer this based on the current Vanguard knowledge graph.";

export const isRefusal = (answer: string) => answer.trim().startsWith(REFUSAL);

const ID_RE = /\b(?:AER-\d+|(?:team|person|proj|doc|ticket|slack|dec)_[a-z0-9_]+)\b/gi;

/** Every number in the text, plus k/m-expanded forms ("150k" -> 150000), as a set of values. */
function numericValues(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?([kKmM])?\b/g)) {
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(v)) continue;
    out.add(v);
    if (m[2]) out.add(v * (m[2].toLowerCase() === "k" ? 1e3 : 1e6));
  }
  return out;
}

/**
 * Programmatic anti-hallucination check. Returns a list of problems (empty = grounded):
 *  - identifiers (AER-123, proj_02, ...) that are not in the data
 *  - money, temperatures, percentages and dates that are not in the data
 *  - an answer that cites no evidence nodes
 */
export function checkGrounding(
  answer: string,
  question: string,
  context: string,
  validEvidenceCount: number
): string[] {
  const problems: string[] = [];
  const haystack = `${context}\n${question}`.toLowerCase();

  if (validEvidenceCount === 0) problems.push("The answer cites no evidence nodes from the data.");

  for (const id of new Set(answer.match(ID_RE) ?? []))
    if (!haystack.includes(id.toLowerCase())) problems.push(`"${id}" does not exist in the data.`);

  const known = numericValues(haystack);
  const figure = /(?:\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?|\d[\d,]*(?:\.\d+)?\s?(?:°\s?[CFcf]|%|[kKmM]\b))/g;
  for (const m of new Set(answer.match(figure) ?? [])) {
    const vals = [...numericValues(m)];
    if (vals.length && !vals.some((v) => known.has(v))) problems.push(`The figure "${m.trim()}" is not in the data.`);
  }

  for (const d of new Set(answer.match(/\d{4}-\d{2}-\d{2}(?:T[\d:]+Z)?/g) ?? []))
    if (!haystack.includes(d.toLowerCase())) problems.push(`The date "${d}" is not in the data.`);

  return problems;
}
