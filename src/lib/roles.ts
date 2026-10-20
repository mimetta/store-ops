/**
 * One place that knows what a role is called and how it looks.
 *
 * kcp-portal kept a `ROLE_BADGE` colour map inside `/admin` and a separate
 * `isAdmin` check in the sidebar, and the two disagreed — which is how
 * `superadmin` came to be styled on four screens while eleven others decided
 * access by comparing against one of its two spellings. The first superadmin
 * bug was exactly that disagreement.
 *
 * So: labels and tones live here, access lives in `permissions.ts`, and
 * neither is copied into a screen. Ten restyle conversions follow /people and
 * several of them show a role.
 */
import type { PortalRole } from "@/types/database"

/** The seven assignable roles, in the order a person should see them. */
export const ASSIGNABLE_ROLES = [
  "admin", "manager", "supervisor", "ka", "people", "marketing", "logistics",
] as const

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

/**
 * `staff` and `inactive` are NOT assignable.
 *
 * `staff` is a legacy marker holding no capabilities — 003 kept it for rows
 * predating 005's move to `ka`, and offering it in a picker is how kcp-portal
 * silently stripped people's access. `inactive` is set by deactivating, which
 * records what the person was first (063), not by choosing it from a list.
 */
export const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  supervisor: "Supervisor",
  ka: "KA",
  people: "People",
  marketing: "Marketing",
  logistics: "Logistics",
  staff: "Staff (no access)",
  inactive: "Inactive",
}

type Tone = "neutral" | "good" | "warn" | "info" | "danger"

/**
 * Tone carries meaning, not decoration.
 *
 * `info` marks the two roles that can change other people's access, so that
 * reads at a glance down a list. `warn` marks `staff`, because a person
 * sitting on it holds nothing and somebody needs to fix that. `danger` marks
 * inactive. Everything else is a plain fact.
 */
const ROLE_TONE: Record<string, Tone> = {
  admin: "info",
  manager: "info",
  supervisor: "neutral",
  ka: "neutral",
  people: "neutral",
  marketing: "neutral",
  logistics: "neutral",
  staff: "warn",
  inactive: "danger",
}

export function roleLabel(role: PortalRole | string | null | undefined): string {
  // NULL is not "unknown" — it is a person who has been invited and not yet
  // given a role (071). Different from `staff`, which means somebody was once
  // something and nobody reassigned them.
  if (role === null || role === undefined) return "No role yet"
  return ROLE_LABEL[role] ?? role
}

/** Class list for a role badge: `<span className={roleBadgeClass(role)}>`. */
export function roleBadgeClass(role: PortalRole | string | null | undefined): string {
  // An invited person with no role is a to-do, so it reads as one.
  if (role === null || role === undefined) return "badge badge-warn"
  return `badge badge-${ROLE_TONE[role] ?? "neutral"}`
}

export const EMPLOYMENT_TYPES = [
  { value: "full_time", label: "Full time" },
  { value: "part_time", label: "Part time" },
  { value: "contract",  label: "Contract" },
  { value: "intern",    label: "Intern" },
] as const

export function employmentLabel(t: string | null | undefined): string {
  return EMPLOYMENT_TYPES.find((e) => e.value === t)?.label ?? "—"
}
