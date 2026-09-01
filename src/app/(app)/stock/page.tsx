"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import { logActivity } from "@/lib/activity"
import type { RetailBranch, Product } from "@/types/retail"

// ── Print styles ──────────────────────────────────────────────────────────────

const PRINT_CSS = `
@media print {
  aside, nav, .no-print { display: none !important; }
  .print-only { display: block !important; }
  body, html { background: white !important; color: black !important; }
  .count-table th, .count-table td {
    color: black !important;
    border: 1px solid #ccc !important;
    background: white !important;
    padding: 5px 8px !important;
  }
  .count-table thead th { background: #f0f0f0 !important; font-weight: 600; }
  @page { margin: 15mm; size: landscape; }
}
`

// ── Types ─────────────────────────────────────────────────────────────────────

type StatusType = "ok" | "low" | "critical"

interface CountRow {
  product: Product
  yesterdayQty: number
  minOverride: number | null
  todayQty: string
  changed: boolean
}

interface WithdrawalRow {
  id: string
  product_id: string
  requested_by: string
  lot_number: string
  withdraw_date: string
  quantity: number
  status: "pending" | "approved" | "rejected"
  notes: string | null
  created_at: string
  products?: { name: string; sku: string }
  profiles?: { full_name: string | null; nickname: string | null }
}

function getStatus(qty: number, globalMin: number, minOverride: number | null): StatusType {
  const min = minOverride ?? globalMin
  if (qty >= min) return "ok"
  if (qty < min * 0.5) return "critical"
  return "low"
}

function StatusBadge({ status }: { status: StatusType }) {
  if (status === "ok")       return <span className="badge bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px]">OK</span>
  if (status === "critical") return <span className="badge bg-red-500/10 text-red-400 border border-red-500/20 text-[10px]">Critical</span>
  return <span className="badge bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px]">Low</span>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StockPage() {
  const { profile } = useProfile()
  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"
  const showYesterday = isManager

  const [branches, setBranches]             = useState<RetailBranch[]>([])
  const [selectedBranch, setSelectedBranch] = useState("")
  const [date, setDate]                     = useState(new Date().toISOString().slice(0, 10))
  const [rows, setRows]                     = useState<CountRow[]>([])
  const [loading, setLoading]               = useState(true)
  const [saving, setSaving]                 = useState(false)
  const [toast, setToast]                   = useState<string | null>(null)
  const [toastType, setToastType]           = useState<"ok" | "warn">("ok")
  const [lastSaved, setLastSaved]           = useState<{ at: string; by: string } | null>(null)
  const [catFilters, setCatFilters]         = useState<string[]>([])
  const [catPanelOpen, setCatPanelOpen]     = useState(false)
  const [statusFilter, setStatusFilter]     = useState<"" | StatusType>("")

  // Scan mode
  const [scanMode, setScanMode]             = useState(false)
  const [scanValue, setScanValue]           = useState("")
  const [highlightedId, setHighlightedId]   = useState<string | null>(null)
  const [showBarcode, setShowBarcode]       = useState(false)
  const [cameraActive, setCameraActive]     = useState(false)
  const [hasBarcodeDetector, setHasBarcodeDetector] = useState(false)

  // Refs
  const catPanelRef        = useRef<HTMLDivElement>(null)
  const scanInputRef       = useRef<HTMLInputElement>(null)
  const rowRefs            = useRef<Record<string, HTMLTableRowElement | null>>({})
  const countInputRefs     = useRef<Record<string, HTMLInputElement | null>>({})
  const videoRef           = useRef<HTMLVideoElement>(null)
  const cameraStreamRef    = useRef<MediaStream | null>(null)
  const isDetectingRef     = useRef(false)
  const animFrameRef       = useRef<number | null>(null)
  const highlightTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rowsRef            = useRef<CountRow[]>([])
  const handleScanRef      = useRef<(barcode: string) => void>(() => {})

  // Withdraw state
  const [withdrawals, setWithdrawals]       = useState<WithdrawalRow[]>([])
  const [withdrawModal, setWithdrawModal]   = useState<Product | null>(null)
  const [wForm, setWForm]                   = useState({ lot_number: "", withdraw_date: date, quantity: "1", notes: "" })
  const [wSaving, setWSaving]               = useState(false)
  const [withdrawalsOpen, setWithdrawalsOpen] = useState(false)

  useEffect(() => {
    setHasBarcodeDetector("BarcodeDetector" in window)
  }, [])

  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  useEffect(() => {
    if (!profile) return
    createClient().from("branches").select("*").eq("active", true).order("name").then(({ data }) => {
      const list = (data ?? []) as RetailBranch[]
      setBranches(list)
      if (!isManager && profile.branch_id) {
        setSelectedBranch(profile.branch_id)
      } else if (list.length > 0) {
        setSelectedBranch((prev) => prev || list[0].id)
      }
    })
  }, [profile?.id])

  const loadData = useCallback(async () => {
    if (!selectedBranch) { setLoading(false); return }
    setLoading(true)
    const sb = createClient()
    const [prodRes, stockRes] = await Promise.all([
      sb.from("products").select("*").eq("type", "fg").eq("active", true).order("name"),
      sb.from("stock_levels").select("*").eq("branch_id", selectedBranch),
    ])
    const products = (prodRes.data ?? []) as Product[]
    const stockMap: Record<string, number> = {}
    const minOverrideMap: Record<string, number | null> = {}
    ;(stockRes.data ?? []).forEach((sl: { product_id: string; quantity: number; minimum_override: number | null }) => {
      stockMap[sl.product_id] = sl.quantity
      minOverrideMap[sl.product_id] = sl.minimum_override ?? null
    })
    setRows(products.map((p) => ({
      product: p,
      yesterdayQty: stockMap[p.id] ?? 0,
      minOverride: minOverrideMap[p.id] ?? null,
      todayQty: "",
      changed: false,
    })))
    setLoading(false)
  }, [selectedBranch])

  const loadWithdrawals = useCallback(async () => {
    if (!selectedBranch) { setWithdrawals([]); return }
    const { data } = await createClient()
      .from("fg_stock_withdrawals")
      .select("*, products(name, sku), profiles!fg_stock_withdrawals_requested_by_fkey(full_name, nickname)")
      .eq("branch_id", selectedBranch)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
    setWithdrawals((data ?? []) as WithdrawalRow[])
  }, [selectedBranch])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => { loadWithdrawals() }, [loadWithdrawals])

  // Close category panel on outside click
  useEffect(() => {
    if (!catPanelOpen) return
    function handler(e: MouseEvent) {
      if (catPanelRef.current && !catPanelRef.current.contains(e.target as Node)) {
        setCatPanelOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [catPanelOpen])

  // Focus scan input when scan mode activates; stop camera when deactivated
  useEffect(() => {
    if (scanMode) {
      setTimeout(() => scanInputRef.current?.focus(), 100)
    } else {
      stopCamera()
      setHighlightedId(null)
      setScanValue("")
    }
  }, [scanMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      stopCamera()
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function showToast(msg: string, type: "ok" | "warn" = "ok") {
    setToast(msg)
    setToastType(type)
    setTimeout(() => setToast(null), 3000)
  }

  function handleScan(barcode: string) {
    const trimmed = barcode.trim()
    if (!trimmed) return
    setScanValue("")

    const found = rowsRef.current.find((r) => r.product.barcode === trimmed)
    if (!found) {
      showToast(`⚠️ Barcode not found: ${trimmed}`, "warn")
      setTimeout(() => scanInputRef.current?.focus(), 50)
      return
    }

    showToast(`Found: ${found.product.name}`)
    setHighlightedId(found.product.id)
    rowRefs.current[found.product.id]?.scrollIntoView({ behavior: "smooth", block: "center" })
    setTimeout(() => { countInputRefs.current[found.product.id]?.focus() }, 350)

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 4000)
  }

  // Keep handleScanRef current so the camera loop always uses the latest version
  useEffect(() => { handleScanRef.current = handleScan })

  function stopCamera() {
    isDetectingRef.current = false
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current = null
    setCameraActive(false)
  }

  async function startCamera() {
    if (!hasBarcodeDetector) { showToast("Camera scanning not supported in this browser", "warn"); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      cameraStreamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraActive(true)
      isDetectingRef.current = true

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new (window as any).BarcodeDetector({ formats: ["code_128", "ean_13", "ean_8", "upc_a", "upc_e"] })
      let lastVal = ""
      let lastAt  = 0

      const detect = async () => {
        if (!isDetectingRef.current) return
        if (videoRef.current && videoRef.current.readyState >= 2) {
          try {
            const results: { rawValue: string }[] = await detector.detect(videoRef.current)
            if (results.length > 0) {
              const val = results[0].rawValue
              const now = Date.now()
              if (val !== lastVal || now - lastAt > 2000) {
                lastVal = val; lastAt = now
                handleScanRef.current(val)
              }
            }
          } catch { /* detection failed — continue */ }
        }
        animFrameRef.current = requestAnimationFrame(detect)
      }
      detect()
    } catch {
      showToast("Could not access camera", "warn")
    }
  }

  function handleCountChange(productId: string, value: string) {
    setRows((prev) => prev.map((r) =>
      r.product.id === productId ? { ...r, todayQty: value, changed: true } : r
    ))
  }

  async function handleSave() {
    if (!profile || !selectedBranch) return
    setSaving(true)
    const sb = createClient()
    const toSave = rows.filter((r) => r.changed && r.todayQty !== "")
    await Promise.all(toSave.map(async (r) => {
      const qty = parseInt(r.todayQty)
      if (isNaN(qty)) return
      await Promise.all([
        sb.from("stock_movements").insert({
          product_id: r.product.id,
          branch_id: selectedBranch,
          movement_type: "adjustment",
          quantity: qty,
          reference: `Count sheet ${date}`,
          notes: null,
          created_by: profile.id,
        }),
        sb.from("stock_levels").upsert({
          product_id: r.product.id,
          branch_id: selectedBranch,
          quantity: qty,
          updated_at: new Date().toISOString(),
        }, { onConflict: "product_id,branch_id" }),
      ])
    }))
    void logActivity({
      action: "stock_count_saved",
      module: "retail_stock",
      branchId: selectedBranch,
      newValue: { items_counted: toSave.length, date },
    })
    setLastSaved({
      at: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      by: profile.nickname ?? profile.full_name ?? profile.email,
    })
    showToast("Count saved")
    setSaving(false)
    loadData()
  }

  function openWithdrawModal(product: Product) {
    setWForm({ lot_number: "", withdraw_date: new Date().toISOString().slice(0, 10), quantity: "1", notes: "" })
    setWithdrawModal(product)
  }

  async function handleWithdrawSubmit() {
    if (!profile || !selectedBranch || !withdrawModal) return
    const qty = parseInt(wForm.quantity)
    if (isNaN(qty) || qty < 1 || !wForm.lot_number.trim()) return
    setWSaving(true)
    const { error } = await createClient().from("fg_stock_withdrawals").insert({
      branch_id: selectedBranch,
      product_id: withdrawModal.id,
      requested_by: profile.id,
      lot_number: wForm.lot_number.trim(),
      withdraw_date: wForm.withdraw_date,
      quantity: qty,
      notes: wForm.notes.trim() || null,
      status: "pending",
    })
    if (error) {
      showToast(`Submit failed: ${error.message}`, "warn")
      setWSaving(false)
      return
    }
    setWithdrawModal(null)
    showToast("Withdrawal request submitted")
    setWSaving(false)
    await loadWithdrawals()
    setWithdrawalsOpen(true)
  }

  async function handleApprove(w: WithdrawalRow) {
    if (!profile) return
    const sb = createClient()
    const { data: sl } = await sb.from("stock_levels").select("quantity").eq("product_id", w.product_id).eq("branch_id", selectedBranch).maybeSingle()
    const current = sl?.quantity ?? 0
    const [r1] = await Promise.all([
      sb.from("fg_stock_withdrawals").update({ status: "approved", approved_by: profile.id }).eq("id", w.id),
      sb.from("stock_levels").upsert(
        { product_id: w.product_id, branch_id: selectedBranch, quantity: Math.max(0, current - w.quantity) },
        { onConflict: "product_id,branch_id" }
      ),
      sb.from("stock_movements").insert({
        product_id: w.product_id,
        branch_id: selectedBranch,
        movement_type: "out",
        quantity: -w.quantity,
        reference: `Withdrawal ${w.lot_number}`,
        notes: w.notes,
        created_by: profile.id,
      }),
    ])
    if (r1.error) { showToast(`Approve failed: ${r1.error.message}`, "warn"); return }
    showToast("Withdrawal approved")
    loadWithdrawals()
    loadData()
  }

  async function handleReject(w: WithdrawalRow) {
    if (!profile) return
    const { error } = await createClient().from("fg_stock_withdrawals").update({ status: "rejected", approved_by: profile.id }).eq("id", w.id)
    if (error) { showToast(`Reject failed: ${error.message}`, "warn"); return }
    showToast("Withdrawal rejected")
    loadWithdrawals()
  }

  function toggleCatFilter(cat: string) {
    setCatFilters((prev) => prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat])
  }

  const computed = rows.map((r) => {
    const n = r.todayQty !== "" ? parseInt(r.todayQty) : null
    const displayQty = n !== null && !isNaN(n) ? n : r.yesterdayQty
    const change = n !== null && !isNaN(n) ? n - r.yesterdayQty : null
    return { ...r, displayQty, change, status: getStatus(displayQty, r.product.reorder_threshold, r.minOverride) }
  })

  const categories = Array.from(new Set(rows.map((r) => r.product.category).filter(Boolean) as string[]))

  const filtered = computed.filter((r) => {
    if (catFilters.length > 0 && !catFilters.includes(r.product.category ?? "")) return false
    if (statusFilter && r.status !== statusFilter) return false
    return true
  })

  const belowMin     = computed.filter((r) => r.status !== "ok").length
  const criticalCount = computed.filter((r) => r.status === "critical").length
  const branchName   = branches.find((b) => b.id === selectedBranch)?.name ?? ""
  const colCount     = (showYesterday ? 10 : 9) + (showBarcode ? 1 : 0)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="print-only hidden">
        <h2 className="text-lg font-bold mb-1">{branchName} — FG Stock Count Sheet</h2>
        <p className="text-sm mb-4">Date: {date}</p>
      </div>

      {/* Topbar */}
      <div className="no-print shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-brand-800 flex-wrap">
        <span className="text-white font-semibold text-sm mr-1">FG Stock</span>

        <select
          value={selectedBranch}
          onChange={(e) => setSelectedBranch(e.target.value)}
          disabled={!isManager}
          className="bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-1.5 outline-none focus:border-white/40 disabled:opacity-60 disabled:cursor-default"
        >
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          {branches.length === 0 && <option value="">No branches</option>}
        </select>

        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-1.5 outline-none focus:border-white/40"
        />

        <div className="ml-auto flex gap-2">
          {/* Scan mode toggle */}
          <button
            onClick={() => setScanMode((v) => !v)}
            className={`flex items-center gap-1.5 text-sm rounded-lg px-3 py-1.5 border transition-colors ${
              scanMode
                ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30"
                : "bg-brand-800 border border-brand-700 text-brand-300 hover:bg-brand-700"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="2" y="2" width="20" height="20" rx="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="10" y1="6" x2="10" y2="18"/><line x1="14" y1="6" x2="14" y2="11"/><line x1="18" y1="6" x2="18" y2="11"/><rect x="13" y="13" width="6" height="6" rx="1"/>
            </svg>
            Scan Mode
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 bg-brand-800 border border-brand-700 text-brand-300 text-sm rounded-lg px-3 py-1.5 hover:bg-brand-700 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Print / PDF
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !selectedBranch}
            className="flex items-center gap-1.5 bg-white text-brand-950 text-sm font-semibold rounded-lg px-4 py-1.5 hover:bg-brand-100 disabled:opacity-40 transition-colors"
          >
            {saving ? "Saving…" : "Save Count"}
          </button>
        </div>
      </div>

      {/* Scan Mode Area */}
      {scanMode && (
        <div className="no-print shrink-0 border-b border-emerald-500/30 bg-emerald-950/20 px-4 py-3">
          <div className="flex items-center gap-3 flex-wrap">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-emerald-400 shrink-0">
              <rect x="2" y="2" width="20" height="20" rx="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="10" y1="6" x2="10" y2="18"/><line x1="14" y1="6" x2="14" y2="11"/><line x1="18" y1="6" x2="18" y2="11"/><rect x="13" y="13" width="6" height="6" rx="1"/>
            </svg>
            <input
              ref={scanInputRef}
              type="text"
              value={scanValue}
              onChange={(e) => setScanValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && scanValue.trim()) handleScan(scanValue.trim()) }}
              placeholder="Scan barcode here — press Enter or use camera…"
              autoComplete="off"
              className="flex-1 bg-brand-900 border border-emerald-500/40 text-white text-sm rounded-lg px-4 py-2 outline-none focus:border-emerald-400 font-mono placeholder:text-brand-600"
            />
            {hasBarcodeDetector && !cameraActive && (
              <button
                onClick={startCamera}
                className="flex items-center gap-1.5 text-sm text-emerald-400 border border-emerald-500/40 rounded-lg px-3 py-1.5 hover:bg-emerald-500/10 transition-colors whitespace-nowrap"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                Use Camera
              </button>
            )}
            {cameraActive && (
              <button
                onClick={stopCamera}
                className="flex items-center gap-1.5 text-sm text-red-400 border border-red-500/30 rounded-lg px-3 py-1.5 hover:bg-red-500/10 transition-colors whitespace-nowrap"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
                Stop Camera
              </button>
            )}
          </div>
          {cameraActive && (
            <div className="mt-3 flex items-start gap-3">
              <video
                ref={videoRef}
                className="w-64 h-40 object-cover rounded-xl bg-black border border-emerald-500/30"
                muted
                playsInline
              />
              <div className="flex flex-col gap-1 pt-1">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-emerald-400 text-xs font-medium">Camera active</span>
                </div>
                <p className="text-brand-500 text-xs">Point at a barcode to scan</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filter row */}
      <div className="no-print shrink-0 flex items-center gap-3 px-4 py-2 border-b border-brand-800 bg-brand-950/40 flex-wrap">
        {/* Multi-select category filter */}
        <div className="relative" ref={catPanelRef}>
          <button
            onClick={() => setCatPanelOpen((v) => !v)}
            className="flex items-center gap-1.5 bg-brand-800 border border-brand-700 text-brand-300 text-xs rounded-lg px-3 py-1.5 outline-none hover:border-white/30"
          >
            {catFilters.length === 0 ? "All categories" : `${catFilters.length} selected`}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`transition-transform ${catPanelOpen ? "rotate-180" : ""}`}><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          {catPanelOpen && (
            <div className="absolute top-full left-0 mt-1 z-30 bg-brand-900 border border-brand-700 rounded-xl shadow-xl min-w-44 py-1">
              <button
                onClick={() => { setCatFilters([]); setCatPanelOpen(false) }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-brand-800 ${catFilters.length === 0 ? "text-white font-semibold" : "text-brand-300"}`}
              >
                All categories
              </button>
              {categories.map((cat) => (
                <label key={cat} className="flex items-center gap-2 px-3 py-1.5 text-xs text-brand-200 hover:bg-brand-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={catFilters.includes(cat)}
                    onChange={() => toggleCatFilter(cat)}
                    className="accent-emerald-500"
                  />
                  {cat}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Active category chips */}
        {catFilters.map((cat) => (
          <span key={cat} className="flex items-center gap-1 bg-brand-700 text-brand-200 text-xs rounded-full px-2.5 py-0.5">
            {cat}
            <button onClick={() => toggleCatFilter(cat)} className="hover:text-white leading-none">×</button>
          </span>
        ))}

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "" | StatusType)}
          className="bg-brand-800 border border-brand-700 text-brand-300 text-xs rounded-lg px-3 py-1.5 outline-none focus:border-white/40"
        >
          <option value="">All statuses</option>
          <option value="ok">OK</option>
          <option value="low">Low</option>
          <option value="critical">Critical</option>
        </select>

        {/* Barcode column toggle */}
        <button
          onClick={() => setShowBarcode((v) => !v)}
          className={`flex items-center gap-1.5 text-xs rounded-lg px-2.5 py-1.5 border transition-colors ${
            showBarcode
              ? "bg-brand-700 border-brand-600 text-brand-200"
              : "bg-transparent border-brand-700 text-brand-500 hover:text-brand-300 hover:border-brand-600"
          }`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="2" width="20" height="20" rx="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="10" y1="6" x2="10" y2="18"/><line x1="14" y1="6" x2="14" y2="11"/><line x1="18" y1="6" x2="18" y2="11"/><rect x="13" y="13" width="6" height="6" rx="1"/></svg>
          Barcode
        </button>

        <span className="text-brand-600 text-xs ml-auto">{filtered.length} of {rows.length} products</span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm count-table">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-brand-700 bg-brand-900">
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs whitespace-nowrap">SKU</th>
              {showBarcode && <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs whitespace-nowrap">Barcode</th>}
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Product name</th>
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Category</th>
              <th className="text-right px-4 py-2.5 text-brand-400 font-medium text-xs">Minimum</th>
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Supplier</th>
              {showYesterday && <th className="text-right px-4 py-2.5 text-brand-400 font-medium text-xs whitespace-nowrap">Yesterday</th>}
              <th className="text-center px-4 py-2.5 text-brand-400 font-medium text-xs whitespace-nowrap">Today&apos;s count</th>
              <th className="text-right px-4 py-2.5 text-brand-400 font-medium text-xs">Change</th>
              <th className="text-left px-4 py-2.5 text-brand-400 font-medium text-xs">Status</th>
              <th className="text-center px-4 py-2.5 text-brand-400 font-medium text-xs">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={colCount} className="px-4 py-16 text-center text-brand-500">Loading…</td></tr>
            ) : !selectedBranch ? (
              <tr><td colSpan={colCount} className="px-4 py-16 text-center text-brand-500">Select a branch to view stock.</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={colCount} className="px-4 py-16 text-center text-brand-500">No products found.</td></tr>
            ) : filtered.map((r) => {
              const isHighlighted = highlightedId === r.product.id
              return (
                <tr
                  key={r.product.id}
                  ref={(el) => { rowRefs.current[r.product.id] = el }}
                  className={`border-b border-brand-800 transition-colors ${
                    isHighlighted ? "ring-2 ring-inset ring-emerald-500 bg-emerald-950/30" :
                    r.status === "critical" ? "bg-red-950/25 hover:bg-red-950/35" :
                    r.status === "low"      ? "bg-amber-950/20 hover:bg-amber-950/30" :
                                              "hover:bg-brand-800/30"
                  }`}
                >
                  <td className="px-4 py-2.5 font-mono text-xs text-brand-400 whitespace-nowrap">{r.product.sku}</td>
                  {showBarcode && (
                    <td className="px-4 py-2.5 font-mono text-xs text-brand-500 whitespace-nowrap">
                      {r.product.barcode ?? <span className="text-brand-700">—</span>}
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-white font-medium">{r.product.name}</td>
                  <td className="px-4 py-2.5 text-brand-400 text-xs">{r.product.category ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right text-brand-300">
                    {r.minOverride != null ? (
                      <span title={`Global minimum: ${r.product.reorder_threshold}`}>{r.minOverride}</span>
                    ) : r.product.reorder_threshold}
                  </td>
                  <td className="px-4 py-2.5 text-brand-400 text-xs">{r.product.supplier ?? "—"}</td>
                  {showYesterday && <td className="px-4 py-2.5 text-right text-brand-300 font-mono">{r.yesterdayQty}</td>}
                  <td className="px-4 py-2.5 text-center">
                    <input
                      ref={(el) => { countInputRefs.current[r.product.id] = el }}
                      type="number"
                      min="0"
                      value={r.todayQty}
                      onChange={(e) => handleCountChange(r.product.id, e.target.value)}
                      placeholder={String(r.yesterdayQty)}
                      className={`w-24 bg-brand-800 text-white text-center text-sm rounded-lg px-3 py-1 outline-none transition-all ${
                        r.changed
                          ? "border-2 border-emerald-500 focus:border-emerald-400"
                          : "border border-brand-700 focus:border-white/40"
                      }`}
                    />
                  </td>
                  <td className={`px-4 py-2.5 text-right font-semibold font-mono ${
                    r.change === null ? "text-brand-600" :
                    r.change > 0     ? "text-emerald-400" :
                    r.change < 0     ? "text-red-400" :
                                       "text-brand-500"
                  }`}>
                    {r.change === null ? "—" : r.change > 0 ? `+${r.change}` : r.change}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-2.5 text-center">
                    <button
                      onClick={() => openWithdrawModal(r.product)}
                      className="text-xs text-brand-400 hover:text-white border border-brand-700 hover:border-brand-500 rounded-lg px-2 py-0.5 transition-colors whitespace-nowrap"
                    >
                      Withdraw
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pending withdrawals section (managers only) */}
      {isManager && selectedBranch && (
        <div className="no-print shrink-0 border-t border-brand-800">
          <button
            onClick={() => setWithdrawalsOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-2 text-xs text-brand-400 hover:text-white hover:bg-brand-800/30 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`transition-transform ${withdrawalsOpen ? "rotate-90" : ""}`}><polyline points="9 18 15 12 9 6"/></svg>
            Pending withdrawals
            {withdrawals.length > 0 && (
              <span className="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[10px] px-1.5 py-0.5 rounded-full">{withdrawals.length}</span>
            )}
          </button>
          {withdrawalsOpen && (
            <div className="max-h-48 overflow-auto border-t border-brand-800/60">
              {withdrawals.length === 0 ? (
                <p className="px-4 py-4 text-center text-brand-600 text-xs">No pending withdrawals</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-brand-900">
                    <tr className="border-b border-brand-800">
                      <th className="text-left px-4 py-2 text-brand-500 font-medium">Product</th>
                      <th className="text-left px-4 py-2 text-brand-500 font-medium">Lot</th>
                      <th className="text-left px-4 py-2 text-brand-500 font-medium">Date</th>
                      <th className="text-right px-4 py-2 text-brand-500 font-medium">Qty</th>
                      <th className="text-left px-4 py-2 text-brand-500 font-medium">Requested by</th>
                      <th className="text-left px-4 py-2 text-brand-500 font-medium">Notes</th>
                      <th className="text-center px-4 py-2 text-brand-500 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withdrawals.map((w) => (
                      <tr key={w.id} className="border-b border-brand-800 hover:bg-brand-800/20">
                        <td className="px-4 py-2 text-white font-medium">{w.products?.name ?? "—"} <span className="text-brand-500 font-mono">{w.products?.sku}</span></td>
                        <td className="px-4 py-2 text-brand-300 font-mono">{w.lot_number}</td>
                        <td className="px-4 py-2 text-brand-400">{w.withdraw_date}</td>
                        <td className="px-4 py-2 text-right text-brand-200 font-semibold">{w.quantity}</td>
                        <td className="px-4 py-2 text-brand-400">{w.profiles?.nickname ?? w.profiles?.full_name ?? "—"}</td>
                        <td className="px-4 py-2 text-brand-500">{w.notes ?? "—"}</td>
                        <td className="px-4 py-2 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button onClick={() => handleApprove(w)} className="text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 rounded px-2 py-0.5 transition-colors">Approve</button>
                            <button onClick={() => handleReject(w)} className="text-red-400 border border-red-500/30 hover:bg-red-500/10 rounded px-2 py-0.5 transition-colors">Reject</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {/* Summary bar */}
      <div className="no-print shrink-0 flex items-center gap-6 px-4 py-2 border-t border-brand-800 bg-brand-800/40 text-xs">
        <span className="text-brand-400">{rows.length} products</span>
        <span className={belowMin > 0 ? "text-amber-400" : "text-brand-500"}>{belowMin} below minimum</span>
        <span className={criticalCount > 0 ? "text-red-400" : "text-brand-500"}>{criticalCount} critical</span>
        {lastSaved && <span className="ml-auto text-brand-500">Saved {lastSaved.at} by {lastSaved.by}</span>}
      </div>

      {/* Withdraw modal */}
      {withdrawModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-brand-900 border border-brand-700 rounded-2xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-brand-800">
              <h3 className="text-white font-semibold">Request Withdrawal</h3>
              <button onClick={() => setWithdrawModal(null)} className="text-brand-500 hover:text-white">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="text-brand-400 text-xs mb-1 block">Product</label>
                <p className="text-white text-sm font-medium">{withdrawModal.name} <span className="text-brand-500 font-mono text-xs">{withdrawModal.sku}</span></p>
              </div>
              <div>
                <label className="text-brand-400 text-xs mb-1 block">Lot number <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={wForm.lot_number}
                  onChange={(e) => setWForm((f) => ({ ...f, lot_number: e.target.value }))}
                  placeholder="e.g. LOT-2026-001"
                  className="w-full bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-white/40"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-brand-400 text-xs mb-1 block">Withdraw date</label>
                  <input
                    type="date"
                    value={wForm.withdraw_date}
                    onChange={(e) => setWForm((f) => ({ ...f, withdraw_date: e.target.value }))}
                    className="w-full bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-white/40"
                  />
                </div>
                <div>
                  <label className="text-brand-400 text-xs mb-1 block">Quantity <span className="text-red-400">*</span></label>
                  <input
                    type="number"
                    min="1"
                    value={wForm.quantity}
                    onChange={(e) => setWForm((f) => ({ ...f, quantity: e.target.value }))}
                    className="w-full bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-white/40"
                  />
                </div>
              </div>
              <div>
                <label className="text-brand-400 text-xs mb-1 block">Notes</label>
                <textarea
                  value={wForm.notes}
                  onChange={(e) => setWForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  placeholder="Optional notes"
                  className="w-full bg-brand-800 border border-brand-700 text-white text-sm rounded-lg px-3 py-2 outline-none focus:border-white/40 resize-none"
                />
              </div>
            </div>
            <div className="px-5 py-4 border-t border-brand-800 flex justify-end gap-2">
              <button onClick={() => setWithdrawModal(null)} className="px-4 py-2 text-sm text-brand-400 hover:text-white transition-colors">Cancel</button>
              <button
                onClick={handleWithdrawSubmit}
                disabled={wSaving || !wForm.lot_number.trim() || !wForm.quantity}
                className="px-4 py-2 text-sm font-semibold bg-white text-brand-950 rounded-lg hover:bg-brand-100 disabled:opacity-40 transition-colors"
              >
                {wSaving ? "Submitting…" : "Submit Request"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 text-sm font-medium px-4 py-3 rounded-xl shadow-xl border ${
          toastType === "warn"
            ? "bg-amber-950 border-amber-500/30 text-amber-300"
            : "bg-emerald-950 border-emerald-500/30 text-emerald-300"
        }`}>
          {toastType === "warn"
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          }
          {toast}
        </div>
      )}
    </div>
  )
}
