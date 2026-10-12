"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

export interface SyncRun {
  id: string; endpoint: string; status: string
  fetched: number; applied: number; skipped: number; pages: number
  startedAt: string; finishedAt: string | null
  errorCode: string | null; errorMessage: string | null
  by: string | null
}
export interface RejectRow {
  prod_code: string | null; wh_code: string | null
  reject_reason: string | null; run_id: string
}

/** 015's vocabulary, with what each one actually means for the data. */
const STATUS: Record<string, { label: string; cls: string; means: string }> = {
  running:     { label: "Running", cls: "badge badge-info",
                 means: "Still going, or it stopped without saying so." },
  ok:          { label: "OK", cls: "badge badge-good",
                 means: "Every page came back and was applied." },
  failed:      { label: "Failed", cls: "badge badge-danger",
                 means: "Nothing can be assumed about what landed." },
  truncated:   { label: "Truncated", cls: "badge badge-warn",
                 means: "A page came back at exactly the row cap, so the data is incomplete — not wrong, just not all of it." },
  auth_failed: { label: "Auth failed", cls: "badge badge-danger",
                 means: "AccCloud refused the credentials. Nothing was fetched." },
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB",
    { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"

export default function SyncClient({
  runs, rejects, productCount, fromAccCloud, lastSyncedAt,
}: {
  runs: SyncRun[]
  rejects: RejectRow[]
  productCount: number
  fromAccCloud: number
  lastSyncedAt: string | null
}) {
  const router = useRouter()
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null)
  const [pending, start] = useTransition()
  const [confirmLive, setConfirmLive] = useState(false)

  const lastRun = runs[0]
  const failed = runs.filter((r) => r.status === "failed" || r.status === "auth_failed").length
  const rejectsByRun = new Map<string, RejectRow[]>()
  for (const r of rejects) {
    if (!rejectsByRun.has(r.run_id)) rejectsByRun.set(r.run_id, [])
    rejectsByRun.get(r.run_id)!.push(r)
  }

  function run(dryRun: boolean) {
    setMsg(null)
    start(async () => {
      try {
        const res = await fetch("/api/acccloud/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun }),
        })
        const json = await res.json()
        if (!res.ok) {
          // The route returns 409 for truncated and 502 for auth — neither is a
          // server fault, and neither is a success. Say which.
          setMsg({ tone: "err",
                   text: json?.error ?? `${json?.status ?? "Failed"} — see the run below.` })
        } else {
          setMsg({
            tone: dryRun ? "warn" : "ok",
            text: dryRun
              ? `Dry run: ${json.productsSeen ?? 0} products seen, nothing written.`
              : `Synced — ${json.productsInserted ?? 0} new, ${json.productsUpdated ?? 0} updated.`,
          })
        }
        setConfirmLive(false)
        router.refresh()
      } catch (e) {
        setMsg({ tone: "err", text: e instanceof Error ? e.message : "The request failed." })
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-lg text-ink">AccCloud sync</h1>
          <p className="text-xs text-muted">
            The product master. {failed > 0 && (
              <span className="text-danger-70">{failed} failed run{failed === 1 ? "" : "s"} · </span>
            )}
            last run {lastRun ? fmt(lastRun.startedAt) : "never"}.
          </p>
        </div>
        <button onClick={() => run(true)} disabled={pending} className="btn btn-ghost">
          {pending ? "Working…" : "Dry run"}
        </button>
        {confirmLive ? (
          <>
            <button onClick={() => run(false)} disabled={pending} className="btn btn-danger">
              Yes — replace the product master
            </button>
            <button onClick={() => setConfirmLive(false)} className="btn btn-ghost">Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirmLive(true)} disabled={pending} className="btn btn-primary">
            Sync for real
          </button>
        )}
      </header>

      {msg && (
        <p className={`note ${msg.tone === "ok" ? "note-g" : msg.tone === "warn" ? "note-i" : "note-r"}`}>
          <span>{msg.text}</span>
        </p>
      )}

      {confirmLive && (
        <p className="note note-a">
          <span>
            This rewrites every product AccCloud knows about — name, group, category.
            It does <strong>not</strong> write units, cost prices or reorder points:
            no endpoint supplies them, and inventing one is worse than leaving it
            blank. It also leaves <strong>source</strong> alone on rows somebody
            entered by hand, so you can still tell which those were.
          </span>
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Active products" value={String(productCount)} />
        <Stat label="From AccCloud" value={String(fromAccCloud)}
              hint={`${productCount - fromAccCloud} entered by hand`} />
        <Stat label="Last synced" value={lastSyncedAt ? fmt(lastSyncedAt) : "never"} />
        <Stat label="Runs recorded" value={String(runs.length)} />
      </div>

      <div className="card">
        <div className="card-pad border-b border-sand">
          <h2 className="text-ink">Runs</h2>
          <p className="text-xs text-muted">Newest first. A status is not a verdict on the data — read what it means.</p>
        </div>
        {runs.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No sync has ever run here.</p>
            <p className="empty-hint">
              A dry run fetches and writes nothing, which is the safe way to see
              what AccCloud would send.
            </p>
          </div>
        ) : runs.map((r) => {
          const s = STATUS[r.status] ?? { label: r.status, cls: "badge badge-neutral", means: "" }
          const rej = rejectsByRun.get(r.id) ?? []
          return (
            <div key={r.id} className="row flex-col items-start gap-1">
              <div className="flex items-center gap-2 w-full flex-wrap">
                <span className={s.cls}>{s.label}</span>
                <span className="text-sm text-ink">{r.endpoint}</span>
                <span className="text-xs text-subtle ml-auto num-c">{fmt(r.startedAt)}</span>
              </div>
              <p className="text-xs text-muted num-c">
                {r.fetched} fetched · {r.applied} applied · {r.skipped} skipped
                {r.pages ? ` · ${r.pages} page${r.pages === 1 ? "" : "s"}` : ""}
                {r.by ? ` · ${r.by}` : ""}
                {r.finishedAt ? "" : " · did not finish"}
              </p>
              {s.means && <p className="text-xs text-subtle">{s.means}</p>}
              {r.errorMessage && (
                <p className="note note-r w-full">
                  <span>
                    {r.errorCode ? <strong>{r.errorCode}: </strong> : null}
                    {r.errorMessage}
                  </span>
                </p>
              )}
              {rej.length > 0 && (
                <details className="w-full">
                  <summary className="text-xs text-muted cursor-pointer">
                    {rej.length} row{rej.length === 1 ? "" : "s"} refused — why
                  </summary>
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    {rej.slice(0, 20).map((x, i) => (
                      <p key={i} className="text-xs text-subtle">
                        <span className="num-c">{x.prod_code ?? "—"}</span>
                        {x.wh_code ? ` @ ${x.wh_code}` : ""} — {x.reject_reason}
                      </p>
                    ))}
                    {rej.length > 20 && (
                      <p className="text-xs text-subtle">…and {rej.length - 20} more</p>
                    )}
                  </div>
                </details>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="text-[11px] text-subtle">{hint}</div>}
    </div>
  )
}
