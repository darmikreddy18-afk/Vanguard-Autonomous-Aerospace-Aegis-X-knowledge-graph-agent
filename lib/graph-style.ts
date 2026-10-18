export const LABEL_COLORS: Record<string, string> = {
  Team: "#7C3AED",
  Person: "#2563EB",
  Project: "#059669",
  Document: "#0891B2",
  Ticket: "#DC2626",
  SlackThread: "#4C1D95",
  Decision: "#F59E0B",
};
export const FALLBACK_COLOR = "#64748B";
export const GOLD = "#EAB308";

export const LABEL_NAMES: Record<string, string> = {
  Team: "Team",
  Person: "Person",
  Project: "Project",
  Document: "Document",
  Ticket: "Ticket",
  SlackThread: "Slack Thread",
  Decision: "Decision",
};

export const NODE_RADIUS: Record<string, number> = {
  Team: 10,
  Project: 9,
  Document: 7,
  Ticket: 7,
  Person: 6.5,
  SlackThread: 6,
  Decision: 8,
};

/** How each relationship reads in the traversal breakdown. `reverse` puts the target first ("Project, Owned by Person"). */
export const RELATION_TEXT: Record<string, { text: string; reverse?: boolean }> = {
  OWNS: { text: "Owned by", reverse: true },
  CONTRIBUTES_TO: { text: "Contributed to by", reverse: true },
  MONITORS: { text: "Monitored by", reverse: true },
  AUTHORED: { text: "Authored by", reverse: true },
  OVERSEES_ARCHITECTURE: { text: "Architecture overseen by", reverse: true },
  NOTIFIED_IF_DELAYED: { text: "Notifies", reverse: true },
  BELONGS_TO: { text: "Belongs to" },
  DEPENDS_ON: { text: "Depends on" },
  AFFECTS: { text: "Affects" },
  DISCUSSES: { text: "Discusses" },
  JUSTIFIES: { text: "Justifies" },
  MANDATED_BY: { text: "Mandated by" },
  VIOLATES_SPEC: { text: "Violates" },
  BLOCKS: { text: "Blocks" },
  CARRIES_FINANCIAL_PENALTY: { text: "Carries penalty" },
  EVALUATES_RISK: { text: "Evaluates risk of" },
  ESCALATES_DELAY: { text: "Escalates delay of" },
  UPDATES: { text: "Updates" },
  DERIVED_FROM: { text: "Derived from" },
  MITIGATES_FAILURE: { text: "Mitigates failure of" },
  REFERENCES_SPEC: { text: "References" },
  SUBCOMPONENT_OF: { text: "Subcomponent of" },
  GOVERNED_BY: { text: "Governed by" },
  DECIDED_IN: { text: "Decided in" },
  DECIDED_BY: { text: "Decided by" },
  CONCERNS: { text: "Concerns" },
  SUPERSEDES: { text: "Supersedes" },
  PREVIOUSLY_OWNED: { text: "Previously owned by", reverse: true },
};

/** Short on-canvas / chip label: ticket key, Slack channel, trimmed document title, else name. */
export function displayLabel(n: { label: string; name: string; [k: string]: unknown }, max = 34): string {
  let text = n.name;
  if (n.label === "Ticket" && typeof n.key === "string") text = n.key;
  else if (n.label === "SlackThread" && typeof n.channel === "string") text = n.channel;
  else if (n.label === "Document" && typeof n.title === "string") text = n.title.replace(/^(Spec|Doc|Notion):\s*/, "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Lucide-style 24x24 stroke icon paths, one per entity type (used in the legend, chips and sidebar). */
export const ICON_PATHS: Record<string, string[]> = {
  // Users
  Team: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  // User
  Person: ["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"],
  // Shield (leadership / admin roles)
  PersonAdmin: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  // Briefcase
  Project: ["M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16", "M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"],
  // File-Text
  Document: [
    "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z",
    "M14 2v6h6",
    "M16 13H8",
    "M16 17H8",
    "M10 9H8",
  ],
  // Bug
  Ticket: [
    "M8 2l1.88 1.88",
    "M14.12 3.88 16 2",
    "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1",
    "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z",
    "M12 20v-9",
    "M6.53 9C4.6 8.8 3 7.1 3 5",
    "M6 13H2",
    "M3 21c0-2.1 1.7-3.9 3.8-4",
    "M20.97 5c0 2.1-1.6 3.8-3.5 4",
    "M22 13h-4",
    "M17.2 17c2.1.1 3.8 1.9 3.8 4",
  ],
  // Message-Square
  SlackThread: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  // Git-Branch (a decision that forks/supersedes)
  Decision: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9"],
};

const ADMIN_ROLE = /chief|director|head of|vice president|\bvp\b|admin|lead\b/i;

/** Which icon a node gets: people in leadership/admin roles get the shield. */
export function iconKey(n: { label: string; role?: unknown }): string {
  if (n.label === "Person" && typeof n.role === "string" && ADMIN_ROLE.test(n.role)) return "PersonAdmin";
  return n.label;
}

/** Apple system font stack, shared by the DOM (via CSS) and every piece of canvas text. */
export const FONT_SANS =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
