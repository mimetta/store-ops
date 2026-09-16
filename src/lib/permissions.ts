/**
 * Single source of truth for "who may do what".
 *
 * Before this module, manager-ness was decided inline in 11 pages and they
 * disagreed — 4 accepted `superadmin`, 7 did not, which is how a superadmin
 * ended up locked out of Settings. Nothing should re-derive permissions from
 * `portal_role` directly any more. Call `can()`.
 *
 * The matrix below is the spec, expressed as data rather than branching, so a
 * change is a change to one table and the disagreement cannot come back.
 *
 * IMPORTANT: this is the UI half only. It decides what a page renders and
 * enables. It is NOT a security boundary — anyone can call the Supabase API
 * directly. The matching database-side enforcement lives in
 * supabase/004-rbac-rls.sql and must be kept in step with this file.
 */

// ── Roles ────────────────────────────────────────────────────────────────────

/** The seven roles people are actually assigned. */
export const ROLES = [
  "admin",
  "manager",
  "supervisor",
  "ka",
  "logistics",
  "people",
  "marketing",
] as const

export type Role = (typeof ROLES)[number]

/**
 * Values that already exist in the production `profiles` table and therefore
 * cannot simply be deleted.
 *
 *   superadmin — treated as a superset of admin (see `can`). Without this the
 *                account currently administering the system loses all access.
 *   staff      — holds no capabilities. Existing `staff` rows need reassigning
 *                to one of the seven before they can do anything.
 *   inactive   — deactivation marker. Holds nothing, by design.
 *
 * `part_time` is deliberately NOT here: part-time is an employment fact, held
 * in profiles.employment_type, not a permission level. See isPartTime().
 */
export const LEGACY_ROLES = ["superadmin", "staff", "inactive"] as const
export type LegacyRole = (typeof LEGACY_ROLES)[number]

export type AnyRole = Role | LegacyRole

// ── Capabilities ─────────────────────────────────────────────────────────────

export const CAPABILITIES = [
  "sales.import",
  "sales.manual",
  // bills = daily count of customer bills by nationality. NOT the till cash
  // reconciliation — that is pos.money. No page exists for bills yet.
  "bills",
  "pos.money",
  "traffic",
  "stock.count",
  "stock.variance.explain",
  "stock.adjustment.approve",
  "stock.reports",
  "receiving",
  "transfers",
  "shifts.view_own",
  "shifts.manage",
  // Split verbs: everyone acts on their own record, a smaller set decides for
  // others. Same shape as shift swaps.
  "leave.request",
  "leave.approve",
  "training.view",
  "training.manage",
  "overtime.record",
  "payout.view",
  "commission.settings",
  "delivery.schedule",
  "calendar.manage",
  "acccloud.sync",
  "settings",
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * The matrix. Each capability lists exactly the roles that hold it.
 *
 * `superadmin` is intentionally absent from every row — it is granted
 * everything by the short-circuit in `can()` rather than by being repeated in
 * every row.
 */
const CAPABILITY_ROLES: Record<Capability, readonly Role[]> = {
  "sales.import":             ["admin", "manager", "supervisor"],
  "sales.manual":             ["admin", "manager", "supervisor"],
  "bills":                    ["admin", "manager", "supervisor"],
  "pos.money":                ["admin", "manager", "supervisor", "ka"],
  "traffic":                  ["admin", "manager", "supervisor"],

  "stock.count":              ["admin", "manager", "supervisor", "ka"],
  "stock.variance.explain":   ["ka"],
  "stock.adjustment.approve": ["admin", "manager"],
  "stock.reports":            ["admin", "manager", "supervisor", "logistics"],

  "receiving":                ["admin", "manager", "supervisor", "ka", "logistics"],
  "transfers":                ["admin", "manager", "supervisor", "logistics"],

  "shifts.view_own":          ["ka"],
  "shifts.manage":            ["admin", "manager", "people"],

  // every role — written out rather than via a constant so the matrix stays
  // literal and machine-comparable against supabase/004-rbac-rls.sql
  "leave.request":            ["admin", "manager", "supervisor", "ka", "logistics", "people", "marketing"],
  "leave.approve":            ["admin", "manager", "people"],
  "training.view":            ["admin", "manager", "supervisor", "ka", "logistics", "people", "marketing"],
  "training.manage":          ["admin", "manager", "people"],

  "overtime.record":          ["admin", "manager", "people"],
  "payout.view":              ["admin", "manager", "people"],
  "commission.settings":      ["admin", "manager"],

  "delivery.schedule":        ["admin", "manager", "logistics"],
  "calendar.manage":          ["admin", "manager", "people", "marketing"],

  "acccloud.sync":            ["admin"],
  "settings":                 ["admin", "manager"],
}

// ── Branch scope ─────────────────────────────────────────────────────────────

/** Roles that see every branch. */
const ALL_BRANCH_ROLES: readonly Role[] = [
  "admin",
  "manager",
  "people",
  "marketing",
  "logistics",
]

export type BranchScope = "all" | "assigned" | "none"

// ── The subject ──────────────────────────────────────────────────────────────

/**
 * Just the fields permissions depend on, so callers can pass a Profile, a
 * partial row, or a hand-built object in a test.
 */
export interface PermissionSubject {
  portal_role?: string | null
  branch_id?: string | null
  employment_type?: string | null
}

function roleOf(user: PermissionSubject | null | undefined): AnyRole | null {
  const r = user?.portal_role?.trim().toLowerCase()
  if (!r) return null
  if ((ROLES as readonly string[]).includes(r)) return r as Role
  if ((LEGACY_ROLES as readonly string[]).includes(r)) return r as LegacyRole
  // Unrecognised value — deny rather than guess.
  return null
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Does this user hold this capability?
 *
 * Denies on a null user, a missing role, or a role string that is not
 * recognised. Failing closed matters: a typo in the database should remove
 * access, not grant it.
 */
export function can(
  user: PermissionSubject | null | undefined,
  capability: Capability
): boolean {
  const role = roleOf(user)
  if (role === null) return false
  if (role === "inactive" || role === "staff") return false
  if (role === "superadmin") return true
  return CAPABILITY_ROLES[capability].includes(role as Role)
}

/** True if the user holds at least one of the given capabilities. */
export function canAny(
  user: PermissionSubject | null | undefined,
  capabilities: readonly Capability[]
): boolean {
  return capabilities.some((c) => can(user, c))
}

/** Which branches this user may see. */
export function branchScope(
  user: PermissionSubject | null | undefined
): BranchScope {
  const role = roleOf(user)
  if (role === null || role === "inactive" || role === "staff") return "none"
  if (role === "superadmin") return "all"
  return ALL_BRANCH_ROLES.includes(role as Role) ? "all" : "assigned"
}

/**
 * May this user see data belonging to this branch?
 *
 * `assigned`-scope users (supervisor, ka) are limited to profiles.branch_id.
 * A user with no branch assigned sees nothing rather than everything.
 */
export function canAccessBranch(
  user: PermissionSubject | null | undefined,
  branchId: string | null | undefined
): boolean {
  const scope = branchScope(user)
  if (scope === "none") return false
  if (scope === "all") return true
  if (!branchId || !user?.branch_id) return false
  return user.branch_id === branchId
}

/**
 * Part-time is an employment fact, never a role. Kept here so the rule has one
 * home: no OT multiplier, no commission, and excluded from the commission pool
 * denominator.
 */
export function isPartTime(user: PermissionSubject | null | undefined): boolean {
  return user?.employment_type?.trim().toLowerCase() === "part_time"
}

/** Every capability this user holds — useful for debugging and admin screens. */
export function capabilitiesOf(
  user: PermissionSubject | null | undefined
): Capability[] {
  return CAPABILITIES.filter((c) => can(user, c))
}

/** Human-readable role names for UI. */
export const ROLE_LABELS: Record<AnyRole, string> = {
  admin: "Admin",
  manager: "Manager",
  supervisor: "Supervisor",
  ka: "KA",
  logistics: "Logistics",
  people: "People",
  marketing: "Marketing",
  superadmin: "Super Admin",
  staff: "Staff (unassigned)",
  inactive: "Inactive",
}
