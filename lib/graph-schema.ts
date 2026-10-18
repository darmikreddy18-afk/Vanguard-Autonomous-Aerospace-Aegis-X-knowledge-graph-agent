/** Exact schema handed to the LLM for Text-to-Cypher. Keep in sync with scripts/seed.ts. */
export const GRAPH_SCHEMA_PROMPT = `Schema for Vanguard Autonomous Aerospace's Aegis-X eVTOL program knowledge graph (FalkorDB). This is the ONLY schema that exists.

## Node labels and properties
(:Team        {id, name, focus})
(:Person      {id, name, role, team_id, email})
(:Project     {id, name, type, status})
(:Document    {id, title, name, type, author_id})            // name == title
(:Ticket      {id, key, summary, severity, status, name})   // key like 'AER-402'; severity like 'P1-Critical'
(:SlackThread {id, channel, topic, timestamp, name})        // channel like '#hardware-ops'
(:Decision    {id, name, statement, status, valid_from, valid_to}) // status 'active' | 'superseded'; valid_to absent while active

Every node has a "name" property usable for display and matching.
Node ids look like: team_hardware, person_06, proj_02, doc_03, ticket_01, slack_02.

## Relationship types (all directed: (source)-[:TYPE]->(target))
DISCUSSES, JUSTIFIES, MANDATED_BY, OWNS, AFFECTS, CONTRIBUTES_TO, DEPENDS_ON, VIOLATES_SPEC, BLOCKS,
CARRIES_FINANCIAL_PENALTY, MONITORS, EVALUATES_RISK, AUTHORED, ESCALATES_DELAY, NOTIFIED_IF_DELAYED,
OVERSEES_ARCHITECTURE, UPDATES, DERIVED_FROM, MITIGATES_FAILURE, REFERENCES_SPEC, SUBCOMPONENT_OF,
GOVERNED_BY, BELONGS_TO, DECIDED_IN, DECIDED_BY, CONCERNS, SUPERSEDES, PREVIOUSLY_OWNED

## Edge patterns that exist in the data
(SlackThread)-[:DISCUSSES]->(Ticket)
(Ticket)-[:AFFECTS | JUSTIFIES | MITIGATES_FAILURE | UPDATES | VIOLATES_SPEC | REFERENCES_SPEC | BLOCKS | ESCALATES_DELAY]->(Project | Document)
(Person)-[:OWNS | CONTRIBUTES_TO | OVERSEES_ARCHITECTURE]->(Project)
(Person)-[:OWNS | MONITORS | AUTHORED]->(Document)
(Person)-[:BELONGS_TO]->(Team)
(Person)-[:NOTIFIED_IF_DELAYED]->(Ticket)
(Project)-[:DEPENDS_ON | SUBCOMPONENT_OF]->(Project)
(Project)-[:CARRIES_FINANCIAL_PENALTY | GOVERNED_BY]->(Document)
(Document)-[:MANDATED_BY | DERIVED_FROM | EVALUATES_RISK]->(Document)
(Decision)-[:DECIDED_IN]->(SlackThread | Document | Ticket)   // provenance: where the decision was made
(Decision)-[:DECIDED_BY]->(Person)
(Decision)-[:CONCERNS]->(Project | Document)
(Decision)-[:SUPERSEDES]->(Decision)                          // newer -> older; the older one has status 'superseded'
(Person)-[:PREVIOUSLY_OWNED {valid_from, valid_to, superseded_by}]->(Project | Document)  // OWNS always means CURRENT owner

## Rules
1. Return ONLY the Cypher query inside a single \`\`\`cypher block. No prose, no comments, no trailing semicolon.
2. Read-only: use MATCH / OPTIONAL MATCH / WHERE / RETURN / WITH / ORDER BY / LIMIT only.
   Never use CREATE, MERGE, SET, DELETE, REMOVE, DROP, CALL, LOAD CSV, or FOREACH.
3. RETURN whole nodes, relationships, or paths (not scalar properties) so the result can be drawn as a graph.
   Bind relationships to variables (e.g. -[r:DEPENDS_ON]->) and return them, or return the path.
4. For multi-hop questions ("what is the downstream impact of...", "root cause", "trace") use variable-length
   paths such as -[*1..4]- or specific chains, and return the path (RETURN p).
5. Match text case-insensitively with toLower(n.name) CONTAINS toLower('...'). Prefer matching by id or key
   (e.g. {key: 'AER-402'}) when the user gives one.
6. Always end with LIMIT 100 or smaller.
7. FalkorDB has no APOC; use only standard openCypher functions.
8. Direction matters. Follow the edge patterns above exactly. If you are not sure of a relationship's direction,
   leave the arrow off: -[r:AFFECTS]- instead of -[r:AFFECTS]->.
9. For "connected to", "impact", "trace", "root cause" or "everything around X" questions, anchor on the named
   entity and use an undirected variable-length path: MATCH p = (x {key: 'AER-402'})-[*1..4]-(y) RETURN p LIMIT 100
10. For questions with several parts, write one MATCH p = ... RETURN p per part and join them with UNION.
    Every part must return the same single column name (p).
11. Prefer returning paths or whole nodes and relationships. Only return scalar values (counts, names) when the
    question asks for a number or a plain list.

## Examples
Q: Who owns the ESC Power Relay Unit?
MATCH (p:Person)-[r:OWNS]->(pr:Project {id: 'proj_02'}) RETURN p, r, pr

Q: What does the Q3 Commercial Delivery Pilot depend on, directly or indirectly?
MATCH path = (pr:Project {id: 'proj_06'})-[:DEPENDS_ON*1..4]->(dep:Project) RETURN path LIMIT 100

Q: Who owns the projects that the Q3 Commercial Delivery Pilot depends on?
MATCH path = (start:Project {name: 'Q3 Commercial Delivery Pilot'})-[:DEPENDS_ON|OWNS*1..3]-(connected) RETURN path LIMIT 100

Q: Trace ticket AER-402 to the Q3 pilot, then show the penalty document, who monitors it, and who is notified of delays.
MATCH p = (t:Ticket {key: 'AER-402'})-[:AFFECTS]->(:Project)<-[:DEPENDS_ON*1..4]-(:Project) RETURN p
UNION
MATCH p = (:Project {id: 'proj_06'})-[:CARRIES_FINANCIAL_PENALTY]->(:Document)<-[:MONITORS]-(:Person) RETURN p
UNION
MATCH p = (:Person)-[:NOTIFIED_IF_DELAYED]->(:Ticket)-[:ESCALATES_DELAY]->(:Project {id: 'proj_06'}) RETURN p

Q: What is the financial exposure if the Q3 pilot slips, and which tickets are involved?
MATCH (pr:Project {id: 'proj_06'})-[c:CARRIES_FINANCIAL_PENALTY]->(d:Document)
OPTIONAL MATCH (t:Ticket)-[a]->(pr)
RETURN pr, c, d, t, a LIMIT 100`;
