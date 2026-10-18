/**
 * The named, parameterised Cypher queries the product depends on.
 * Every question the agent can answer by graph traversal maps to exactly one of these.
 * Parameters are always passed as query params ($id, $since), never string-interpolated.
 *
 * Conventions: OWNS = CURRENT owner. A replaced owner becomes PREVIOUSLY_OWNED (with valid_to).
 * Decision.status = 'active' | 'superseded'; SUPERSEDES points newer -> older.
 */
export type Intent = "owner" | "who_knows" | "provenance" | "history" | "changes" | "dependency_owners";

export interface NamedQuery {
  label: string;
  cypher: string;
  /** Node labels the $id anchor may have; null = query takes no anchor. */
  anchors: string[] | null;
}

const KNOW_RELS = `['OWNS','AUTHORED','CONTRIBUTED_TO_SPEC','CODE_REVIEWED','APPROVED_ARCHITECTURE','OVERSEES_ARCHITECTURE','CONTRIBUTES_TO','MONITORS','NOTIFIED_IF_DELAYED','PREVIOUSLY_MAINTAINED','PREVIOUSLY_OWNED']`;

export const QUERIES: Record<Intent, NamedQuery> = {
  // Q1 — Who owns X? (current owner, team, and previous owner if ownership moved)
  owner: {
    label: "Q1 owner",
    anchors: ["Project", "Document"],
    cypher: `MATCH (p:Person)-[o:OWNS]->(x {id: $id})
OPTIONAL MATCH (p)-[:BELONGS_TO]->(t:Team)
OPTIONAL MATCH (prev:Person)-[h:PREVIOUSLY_OWNED]->(x)
RETURN x.id AS subject_id, x.name AS subject, p.id AS owner_id, p.name AS owner, p.role AS role,
       t.name AS team, o.valid_from AS owner_since,
       prev.id AS prev_owner_id, prev.name AS prev_owner, h.valid_to AS prev_owner_until`,
  },

  // Q2 — Who knows about Y? (1 hop: direct relationship; 2 hops: via a neighbouring project/doc/ticket)
  who_knows: {
    label: "Q2 who knows",
    anchors: ["Project", "Document", "Ticket"],
    cypher: `MATCH (p:Person)-[r]->(y {id: $id})
WHERE type(r) IN ${KNOW_RELS}
RETURN p.id AS person_id, p.name AS person, p.role AS role, type(r) AS via, 1 AS hops, y.id AS about_id, y.name AS about, '' AS through
UNION
MATCH (p:Person)-[r1]->(m)-[r2]-(y {id: $id})
WHERE (m:Project OR m:Document OR m:Ticket) AND p.id <> y.id AND m.id <> y.id
  AND type(r1) IN ['OWNS','AUTHORED','CONTRIBUTED_TO_SPEC','CODE_REVIEWED','MONITORS']
  AND type(r2) IN ['AFFECTS','DISCUSSES','DEPENDS_ON','REFERENCES_SPEC','UPDATES','DERIVED_FROM','MANDATED_BY','GOVERNED_BY','JUSTIFIES','CONCERNS','DECIDED_IN']
RETURN p.id AS person_id, p.name AS person, p.role AS role, type(r1) + ' -> ' + type(r2) AS via, 2 AS hops, y.id AS about_id, y.name AS about, m.name AS through`,
  },

  // Q3 — Why was decision Z made, and where does it come from? (decision -> source chain)
  provenance: {
    label: "Q3 provenance",
    anchors: ["Decision"],
    cypher: `MATCH path = (d:Decision {id: $id})-[:DECIDED_IN|DERIVED_FROM|DISCUSSES|UPDATES|MANDATED_BY|JUSTIFIES|REFERENCES_SPEC*1..4]->(src)
WHERE NOT (src)-[:DERIVED_FROM|DISCUSSES|UPDATES|MANDATED_BY|JUSTIFIES|REFERENCES_SPEC]->()
OPTIONAL MATCH (d)-[:DECIDED_BY]->(who:Person)
RETURN d.id AS decision_id, d.statement AS statement, d.status AS status, d.valid_from AS decided_at,
       who.name AS decided_by, [n IN nodes(path) | n.id] AS chain_ids, [n IN nodes(path) | n.name] AS chain_names,
       [r IN relationships(path) | type(r)] AS chain_rels, length(path) AS hops
ORDER BY hops DESC`,
  },

  // Q4 — Supersession: every decision about a subject, current first, with what replaced what
  history: {
    label: "Q4 decision history",
    anchors: ["Project", "Document"],
    cypher: `MATCH (d:Decision)-[:CONCERNS]->(x {id: $id})
OPTIONAL MATCH (d)-[:SUPERSEDES]->(older:Decision)
OPTIONAL MATCH (newer:Decision)-[:SUPERSEDES]->(d)
RETURN x.name AS subject, d.id AS decision_id, d.statement AS statement, d.status AS status,
       d.valid_from AS valid_from, d.valid_to AS valid_to,
       older.id AS supersedes_id, newer.id AS superseded_by_id
ORDER BY d.valid_from DESC`,
  },

  // Q5 — What changed since $since? (decisions, ownership moves, Slack activity)
  changes: {
    label: "Q5 changes since",
    anchors: null,
    cypher: `MATCH (d:Decision) WHERE d.valid_from >= $since
RETURN 'decision_made' AS change, d.id AS id, d.statement AS what, d.valid_from AS at
UNION
MATCH (d:Decision) WHERE d.status = 'superseded' AND d.valid_to >= $since
RETURN 'decision_superseded' AS change, d.id AS id, d.statement AS what, d.valid_to AS at
UNION
MATCH (p:Person)-[o:OWNS]->(x) WHERE o.valid_from >= $since
RETURN 'owner_assigned' AS change, x.id AS id, p.name + ' now owns ' + x.name AS what, o.valid_from AS at
UNION
MATCH (p:Person)-[h:PREVIOUSLY_OWNED]->(x) WHERE h.valid_to >= $since
RETURN 'owner_ended' AS change, x.id AS id, p.name + ' no longer owns ' + x.name AS what, h.valid_to AS at
UNION
MATCH (s:SlackThread) WHERE s.timestamp >= $since
RETURN 'slack_thread' AS change, s.id AS id, s.name AS what, s.timestamp AS at`,
  },

  // Q6 — Who owns what the project depends on? (multi-hop, shortest depth per dependency)
  dependency_owners: {
    label: "Q6 dependency owners",
    anchors: ["Project"],
    cypher: `MATCH path = (start:Project {id: $id})-[:DEPENDS_ON*1..4]->(dep:Project)
MATCH (p:Person)-[:OWNS]->(dep)
RETURN dep.id AS dep_id, dep.name AS dependency, min(length(path)) AS depth, p.id AS owner_id, p.name AS owner
ORDER BY depth`,
  },
};

/** Resolve "why is <project/doc> like this?" to the ACTIVE decision about it. */
export const ACTIVE_DECISION_FOR = `MATCH (d:Decision {status: 'active'})-[:CONCERNS]->(x {id: $id}) RETURN d.id AS id LIMIT 1`;

/** Write events (the "newer fact arrives" path). Each returns a row only if it actually changed something. */
export const EVENT_SUPERSEDE_DECISION = `MATCH (old:Decision {id: $oldId}) WHERE old.status = 'active'
MATCH (src {id: $sourceId})
MATCH (who:Person {id: $byId})
SET old.status = 'superseded', old.valid_to = $at
CREATE (new:Decision {id: $newId, name: $name, statement: $statement, status: 'active', valid_from: $at})
CREATE (new)-[:SUPERSEDES]->(old)
CREATE (new)-[:DECIDED_IN]->(src)
CREATE (new)-[:DECIDED_BY]->(who)
WITH new, old
MATCH (old)-[:CONCERNS]->(x)
CREATE (new)-[:CONCERNS]->(x)
RETURN new.id AS new_id, old.id AS old_id, x.id AS concerns`;

export const EVENT_CHANGE_OWNER = `MATCH (old:Person)-[o:OWNS]->(x {id: $id})
MATCH (np:Person {id: $newOwnerId}) WHERE old.id <> np.id
WITH old, o, x, np, o.valid_from AS since
DELETE o
CREATE (old)-[:PREVIOUSLY_OWNED {valid_from: since, valid_to: $at, superseded_by: np.id}]->(x)
CREATE (np)-[:OWNS {valid_from: $at}]->(x)
RETURN old.id AS old_owner, np.id AS new_owner, x.id AS subject`;
