"use client"

import { useMemo, useState, useTransition } from "react"
import {
  ASSIGNABLE_ROLES, EMPLOYMENT_TYPES, employmentLabel, roleBadgeClass, roleLabel,
} from "@/lib/roles"
import { updatePerson, deactivatePerson, reactivatePerson } from "./actions"

export interface BranchOption { id: string; name: string }

export interface Person {
  id: string
  full_name: string | null
  nickname: string | null
  email: string
  portal_role: string
  branch_id: string | null
  employment_type: string | null
  default_work_days: number | null
  role_before_inactive: string | null
  start_date: string | null
  branchName: string | null
}

const displayName = (p: Person) => p.nickname ?? p.full_name ?? p.email

export default function PeopleClient({
  people, branches, isAdmin, viewerId,
}: {
  people: Person[]
  branches: BranchOption[]
  isAdmin: boolean
  viewerId: string
}) {
  const [search, setSearch] = useState("")
  const [showInactive, setShowInactive] = useState(false)
  const [open, setOpen] = useState<Person | null>(null)
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return people
      .filter((p) => (showInactive ? true : p.portal_role !== "inactive"))
      .filter((p) =>
        !q ||
        displayName(p).toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        (p.branchName ?? "").toLowerCase().includes(q))
  }, [people, search, showInactive])

  const inactiveCount = people.filter((p) => p.portal_role === "inactive").length

  // Somebody on `staff` holds no capabilities at all. That is not a role, it
  // is a person who cannot do anything — worth surfacing rather than leaving
  // for whoever notices their app is blank.
  const strandedCount = people.filter((p) => p.portal_role === "staff").length

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) {
    setMsg(null)
    startTransition(async () => {
      const r = await fn()
      setMsg(r.ok ? { tone: "ok", text: okText } : { tone: "err", text: r.error ?? "Failed." })
      if (r.ok) setOpen(null)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[12rem]">
          <h1 className="text-lg text-ink">People</h1>
          <p className="text-xs text-muted">
            {people.length} {people.length === 1 ? "person" : "people"}
            {inactiveCount > 0 && <> · {inactiveCount} inactive</>}
          </p>
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email or branch"
          className="input-field max-w-xs"
        />
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </header>

      {strandedCount > 0 && (
        <p className="note note-a">
          <span>
            {strandedCount} {strandedCount === 1 ? "person holds" : "people hold"} the
            legacy <strong>staff</strong> role, which grants nothing at all — their app
            will be empty until they are given a real one.
          </span>
        </p>
      )}

      {msg && (
        <p className={msg.tone === "ok" ? "note note-g" : "note note-r"}>
          <span>{msg.text}</span>
        </p>
      )}

      <div className="card">
        {shown.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Nobody matches.</p>
            <p className="empty-hint">
              {search
                ? "Try a different name, email or branch."
                : inactiveCount > 0
                  ? "Everybody here is deactivated — tick “Show inactive” to see them."
                  : "This screen does not create people. Accounts appear here once somebody signs in."}
            </p>
          </div>
        ) : (
          shown.map((p) => (
            <button key={p.id} onClick={() => { setMsg(null); setOpen(p) }} className="row-tap">
              <span className="flex-1 min-w-0">
                <span className="block text-ink truncate">{displayName(p)}</span>
                <span className="block text-xs text-muted truncate">{p.email}</span>
              </span>
              <span className="text-xs text-muted hidden sm:block w-28 truncate">
                {p.branchName ?? "—"}
              </span>
              <span className="text-xs text-muted hidden md:block w-20 truncate">
                {employmentLabel(p.employment_type)}
              </span>
              <span className={roleBadgeClass(p.portal_role)}>{roleLabel(p.portal_role)}</span>
            </button>
          ))
        )}
      </div>

      {open && (
        <PersonDrawer
          person={open}
          branches={branches}
          isAdmin={isAdmin}
          isSelf={open.id === viewerId}
          pending={pending}
          onClose={() => setOpen(null)}
          onSave={(patch) => run(() => updatePerson(open.id, patch), "Saved.")}
          onDeactivate={() => run(() => deactivatePerson(open.id), "Deactivated.")}
          onReactivate={() => run(() => reactivatePerson(open.id), "Reactivated.")}
        />
      )}
    </div>
  )
}

function PersonDrawer({
  person, branches, isAdmin, isSelf, pending, onClose, onSave, onDeactivate, onReactivate,
}: {
  person: Person
  branches: BranchOption[]
  isAdmin: boolean
  isSelf: boolean
  pending: boolean
  onClose: () => void
  onSave: (patch: {
    portalRole?: string; branchId?: string | null
    employmentType?: string | null; defaultWorkDays?: number | null
  }) => void
  onDeactivate: () => void
  onReactivate: () => void
}) {
  const [role, setRole] = useState(person.portal_role)
  const [branchId, setBranchId] = useState(person.branch_id ?? "")
  const [employment, setEmployment] = useState(person.employment_type ?? "")
  const [workDays, setWorkDays] = useState(
    person.default_work_days === null ? "" : String(person.default_work_days))

  const inactive = person.portal_role === "inactive"
  // Employment facts need people.manage AND a different person (064). An
  // administrator is exempt. Mirrored from the trigger, never instead of it.
  const mayEditEmployment = isAdmin || !isSelf

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-ink/20 p-0 sm:p-4">
      <div className="card w-full sm:max-w-md max-h-full overflow-auto">
        <div className="card-pad flex flex-col gap-4">
          <div>
            <h2 className="text-ink">{displayName(person)}</h2>
            <p className="text-xs text-muted">{person.email}</p>
          </div>

          {/* ── role ─────────────────────────────────────────────────────── */}
          <div>
            <label className="block text-xs text-muted mb-1.5">Role</label>
            {isAdmin && !inactive ? (
              <select value={role} onChange={(e) => setRole(e.target.value)} className="input-field">
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{roleLabel(r)}</option>
                ))}
                {/* `staff` is offered ONLY to somebody already on it, so an
                    administrator can move them off without the value being a
                    choice anybody can land on by accident. */}
                {person.portal_role === "staff" && (
                  <option value="staff">{roleLabel("staff")}</option>
                )}
              </select>
            ) : (
              <>
                <p className="flex items-center gap-2">
                  <span className={roleBadgeClass(person.portal_role)}>
                    {roleLabel(person.portal_role)}
                  </span>
                </p>
                {!isAdmin && (
                  <p className="text-xs text-muted mt-1.5">
                    Only an administrator can change a role.
                  </p>
                )}
              </>
            )}
          </div>

          {/* ── employment facts ─────────────────────────────────────────── */}
          <div>
            <label className="block text-xs text-muted mb-1.5">Branch</label>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              disabled={!mayEditEmployment}
              className="input-field"
            >
              <option value="">— none —</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted mb-1.5">Employment type</label>
              <select
                value={employment}
                onChange={(e) => setEmployment(e.target.value)}
                disabled={!mayEditEmployment}
                className="input-field"
              >
                <option value="">— not known yet —</option>
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1.5">Work days / month</label>
              <input
                type="number" min={1} max={31} inputMode="numeric"
                value={workDays}
                onChange={(e) => setWorkDays(e.target.value)}
                disabled={!mayEditEmployment}
                placeholder="not known"
                className="input-num"
              />
            </div>
          </div>

          <p className="text-xs text-muted">
            Work days is the divisor for overtime — salary ÷ work days ÷ 8 — so it
            changes what an hour costs. Blank means nobody has said yet.
          </p>

          {isSelf && !isAdmin && (
            <p className="note note-i">
              <span>
                These are your own details. An administrator changes them, so that
                nobody can move their own branch or work days.
              </span>
            </p>
          )}

          {inactive && (
            <p className="note note-a">
              <span>
                Deactivated.{" "}
                {person.role_before_inactive
                  ? <>They were <strong>{roleLabel(person.role_before_inactive)}</strong> and will
                    be restored to it.</>
                  : <>No stored role — they were deactivated before that was recorded, so an
                    administrator must choose one.</>}
              </span>
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={() => onSave({
                ...(isAdmin && !inactive && role !== person.portal_role ? { portalRole: role } : {}),
                ...(mayEditEmployment ? {
                  branchId: branchId || null,
                  employmentType: employment || null,
                  defaultWorkDays: workDays.trim() === "" ? null : Number(workDays),
                } : {}),
              })}
              disabled={pending}
              className="btn btn-primary flex-1"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button onClick={onClose} disabled={pending} className="btn btn-ghost">Cancel</button>
          </div>

          {isAdmin && (
            <div className="border-t border-sand pt-3">
              {inactive ? (
                <button
                  onClick={onReactivate}
                  disabled={pending || !person.role_before_inactive}
                  className="btn btn-ghost w-full"
                >
                  Reactivate as {roleLabel(person.role_before_inactive) ?? "—"}
                </button>
              ) : isSelf ? (
                <p className="text-xs text-muted">You cannot deactivate yourself.</p>
              ) : (
                <button onClick={onDeactivate} disabled={pending} className="btn btn-danger w-full">
                  Deactivate
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
