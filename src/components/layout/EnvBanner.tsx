/**
 * Environment banner.
 *
 * Renders a loud bar across the top of every page whenever the app is NOT
 * running against production, so nobody confuses a UAT tab with a live one.
 *
 * Driven by NEXT_PUBLIC_APP_ENV:
 *
 *   production  -> renders nothing
 *   uat         -> amber "UAT" bar
 *   local       -> slate "LOCAL" bar
 *   (unset)     -> treated as local, so a misconfigured deploy shouts rather
 *                  than silently impersonating production
 *
 * Deliberately fails LOUD: only the exact string "production" hides the
 * banner. A typo, an empty value, or a forgotten variable all show a banner.
 * The opposite default would let a UAT build masquerade as production.
 *
 * NEXT_PUBLIC_* values are inlined at BUILD time, not read at runtime — so
 * changing this variable requires a redeploy to take effect.
 */

type EnvKey = "uat" | "local"

const STYLES: Record<EnvKey, { bg: string; label: string; detail: string }> = {
  uat: {
    bg: "bg-amber-50 text-amber-70 border-b border-amber-60",
    label: "UAT",
    detail: "Test environment — data here is not real and may be wiped",
  },
  local: {
    bg: "bg-panel text-muted border-b border-sand",
    label: "LOCAL",
    detail: "Development machine",
  },
}

export default function EnvBanner() {
  const raw = process.env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase()

  if (raw === "production") return null

  const key: EnvKey = raw === "uat" ? "uat" : "local"
  const { bg, label, detail } = STYLES[key]

  return (
    <div
      role="status"
      aria-label={`${label} environment`}
      className={`${bg} shrink-0 w-full px-4 py-1.5 flex items-center justify-center gap-3 text-center`}
    >
      <span className="font-bold tracking-widest text-xs uppercase">
        {label}
      </span>
      <span className="text-xs font-medium opacity-90 hidden sm:inline">
        {detail}
      </span>
      {raw !== "uat" && raw !== "local" && raw !== undefined && (
        <span className="text-xs font-semibold underline underline-offset-2">
          unrecognised NEXT_PUBLIC_APP_ENV: &quot;{raw}&quot;
        </span>
      )}
      {raw === undefined && (
        <span className="text-xs font-semibold underline underline-offset-2">
          NEXT_PUBLIC_APP_ENV is not set
        </span>
      )}
    </div>
  )
}
