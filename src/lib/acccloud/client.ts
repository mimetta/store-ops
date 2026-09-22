import "server-only"

/**
 * AccCloud API client.
 *
 * `import "server-only"` above makes importing this file from a client
 * component a BUILD error, not a runtime one. That matters more than usual
 * here: the keys are sent as request headers, so a client-side call would ship
 * them to every visitor's browser.
 *
 * Direction is inbound only. Nothing is ever written back to AccCloud.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RECORDED SPEC IS WRONG FOR THIS TENANT
 * ─────────────────────────────────────────────────────────────────────────
 * onest-wms D-24 describes a `{ status: "000", message, data }` envelope.
 * What MMT2025 actually returns from getProductRemain is a BARE JSON ARRAY.
 * An adapter checking `json.status === "000"` treats every successful call as
 * a failure. Everything below is written from observed responses on
 * 2026-09-22 — see docs/acccloud-findings.md.
 */

const BASE = "https://acccloud.me/api"

/**
 * The row cap. `searchAll: "N"` returns at most this many rows with no
 * indication that it truncated — a page of exactly this length is
 * indistinguishable from a complete one, which is why hitting it is treated
 * as a failure rather than a result.
 */
export const ROW_CAP = 1000

export class AccCloudAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AccCloudAuthError"
  }
}

export class AccCloudTruncatedError extends Error {
  constructor(public readonly context: string) {
    super(
      `AccCloud returned exactly ${ROW_CAP} rows for ${context}. The response ` +
        `is capped and silently incomplete — treating it as a full result would ` +
        `under-report stock. Narrow the query and retry.`
    )
    this.name = "AccCloudTruncatedError"
  }
}

function credentials() {
  const apiKey = process.env.ACCCLOUD_API_KEY
  const secretKey = process.env.ACCCLOUD_SECRET_KEY
  const companyCode = process.env.ACCCLOUD_COMPANY_CODE

  const missing = [
    !apiKey && "ACCCLOUD_API_KEY",
    !secretKey && "ACCCLOUD_SECRET_KEY",
    !companyCode && "ACCCLOUD_COMPANY_CODE",
  ].filter(Boolean)

  if (missing.length) {
    throw new Error(
      `AccCloud is not configured: ${missing.join(", ")} missing. These are ` +
        `server-only and must never carry a NEXT_PUBLIC_ prefix.`
    )
  }
  return { apiKey: apiKey!, secretKey: secretKey!, companyCode: companyCode! }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { apiKey, secretKey, companyCode } = credentials()

  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "x-secret-key": secretKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ companyCode, ...body }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  })

  // A key reset invalidates the pair immediately. Naming that cause is the
  // difference between a five-minute fix and an afternoon in the wrong logs.
  if (res.status === 401 || res.status === 403) {
    throw new AccCloudAuthError(
      "AccCloud rejected the credentials. The API keys may have been reset — " +
        "generate a new pair under setup → api-document and update " +
        "ACCCLOUD_API_KEY and ACCCLOUD_SECRET_KEY."
    )
  }

  const text = await res.text()

  if (!res.ok) {
    throw new Error(
      `AccCloud ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`
    )
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(
      `AccCloud ${path} returned a non-JSON body: ${text.slice(0, 300)}`
    )
  }

  // Defensive: if the tenant is ever migrated to the enveloped shape D-24
  // describes, unwrap it rather than silently returning an object where an
  // array is expected.
  if (json && !Array.isArray(json) && typeof json === "object") {
    const o = json as Record<string, unknown>
    if ("status" in o && o.status !== "000") {
      throw new Error(
        `AccCloud ${path} reported status ${JSON.stringify(o.status)}: ${String(o.message ?? "")}`
      )
    }
    if ("data" in o) return o.data as T
  }

  return json as T
}

/** One row of getProductRemain, as the API actually returns it. */
export interface ProductRemainRow {
  masterId: number
  prodCode: string
  /** The product name. NOT `prodTName` — that field does not exist here. */
  productName: string
  balance: number
  warehouse: string
  whCode: string
  productGroup: string | null
  productGroupCode: string | null
}

/**
 * Quantity on hand per product per warehouse.
 *
 * Balances only: no unit, no conversion factor, no barcode. It cannot build an
 * item master on its own, but its product columns are enough to populate one.
 *
 * @throws AccCloudTruncatedError if a page comes back at exactly ROW_CAP.
 */
export async function getProductRemain(opts: {
  searchAll?: "Y" | "N"
  productGroupCode?: string
} = {}): Promise<ProductRemainRow[]> {
  const { searchAll = "N", productGroupCode } = opts
  const body: Record<string, unknown> = { searchAll }
  if (productGroupCode) body.productGroupCode = productGroupCode

  const rows = await post<ProductRemainRow[]>("/support/Product/getProductRemain", body)

  if (!Array.isArray(rows)) {
    throw new Error(
      `AccCloud getProductRemain returned ${typeof rows}, expected an array. ` +
        `The response shape may have changed — see docs/acccloud-findings.md.`
    )
  }

  if (searchAll === "N" && rows.length === ROW_CAP) {
    throw new AccCloudTruncatedError(
      productGroupCode ? `productGroupCode=${productGroupCode}` : "an unfiltered query"
    )
  }

  return rows
}

/**
 * Every product group code the tenant uses.
 *
 * Needed before paging can start, and there is no endpoint that lists them —
 * they are read off a full pull. Uses `searchAll: "Y"`, which is not subject
 * to the cap in the same way; the per-group calls that follow are the ones
 * that get checked.
 */
export async function listProductGroupCodes(): Promise<string[]> {
  const rows = await getProductRemain({ searchAll: "Y" })
  const codes = new Set<string>()
  for (const r of rows) if (r.productGroupCode) codes.add(r.productGroupCode)
  return Array.from(codes).sort()
}
