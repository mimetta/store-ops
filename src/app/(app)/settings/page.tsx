"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { useProfile } from "@/lib/hooks"
import PageHeader from "@/components/retail/PageHeader"
import Drawer from "@/components/retail/Drawer"
import { logActivity } from "@/lib/activity"
import type { RetailBranch, Product, Supplier } from "@/types/retail"

// ── Toast ─────────────────────────────────────────────────────────────────────

interface Toast { id: number; type: "ok" | "err"; text: string }

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)
  function show(type: "ok" | "err", text: string) {
    const id = ++counter.current
    setToasts((t) => [...t, { id, type, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500)
  }
  return { toasts, show }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = "branches" | "suppliers" | "fg" | "consumables" | "stock-levels"
const TABS: { key: Tab; label: string }[] = [
  { key: "branches",     label: "Branches" },
  { key: "suppliers",    label: "Suppliers" },
  { key: "fg",           label: "Products (FG)" },
  { key: "consumables",  label: "Consumables" },
  { key: "stock-levels", label: "Stock levels & branch minimums" },
]

// ── Branch tab ────────────────────────────────────────────────────────────────

const EMPTY_BRANCH = { name: "", location: "", active: true }

function BranchesTab({ toast }: { toast: (t: "ok" | "err", m: string) => void }) {
  const supabase = createClient()
  const [branches, setBranches] = useState<RetailBranch[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<RetailBranch | null>(null)
  const [form, setForm] = useState(EMPTY_BRANCH)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from("branches").select("*").order("name")
    setBranches((data ?? []) as RetailBranch[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openAdd() { setEditing(null); setForm(EMPTY_BRANCH); setDrawerOpen(true) }
  function openEdit(b: RetailBranch) { setEditing(b); setForm({ name: b.name, location: b.location ?? "", active: b.active }); setDrawerOpen(true) }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload = { name: form.name, location: form.location || null, active: form.active }
    const { error } = editing
      ? await supabase.from("branches").update(payload).eq("id", editing.id)
      : await supabase.from("branches").insert(payload)
    if (error) { toast("err", error.message) } else {
      toast("ok", editing ? "Branch updated." : "Branch added.")
      void logActivity({ action: editing ? "branch_updated" : "branch_created", module: "retail_settings", recordLabel: form.name })
      setDrawerOpen(false); load()
    }
    setSaving(false)
  }

  async function toggleActive(b: RetailBranch) {
    await supabase.from("branches").update({ active: !b.active }).eq("id", b.id)
    toast("ok", `${b.name} ${b.active ? "deactivated" : "activated"}.`)
    load()
  }

  return (
    <>
      <div className="flex justify-end mb-4">
        <button onClick={openAdd} className="btn-primary text-sm py-2 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Branch
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-brand-700">
            <th className="text-left px-4 py-3 text-brand-400 font-medium">Name</th>
            <th className="text-left px-4 py-3 text-brand-400 font-medium">Location</th>
            <th className="text-left px-4 py-3 text-brand-400 font-medium">Status</th>
            <th className="px-4 py-3" />
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={4} className="px-4 py-10 text-center text-brand-500">Loading…</td></tr>
              : branches.map((b) => (
              <tr key={b.id} className="border-b border-brand-800 hover:bg-brand-800/40 transition-colors">
                <td className="px-4 py-3 text-white font-medium">{b.name}</td>
                <td className="px-4 py-3 text-brand-400">{b.location ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`badge border ${b.active ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-brand-700 text-brand-400 border-brand-600"}`}>
                    {b.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => openEdit(b)} className="btn-ghost text-xs py-1 px-2 border border-brand-700">Edit</button>
                    <button onClick={() => toggleActive(b)} className="btn-ghost text-xs py-1 px-2 border border-brand-700">
                      {b.active ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title={editing ? "Edit Branch" : "Add Branch"}>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Branch name *</label>
            <input required type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Siam Discovery" className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Location</label>
            <input type="text" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Siam" className="input-field" />
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setForm({ ...form, active: !form.active })}
              className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${form.active ? "bg-emerald-500" : "bg-brand-700"}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-1 ${form.active ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            <span className="text-sm text-brand-300">Active</span>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving} className="btn-primary flex-1 py-2.5">{saving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => setDrawerOpen(false)} className="btn-ghost flex-1 py-2.5 border border-brand-700">Cancel</button>
          </div>
        </form>
      </Drawer>
    </>
  )
}

// ── Suppliers tab ─────────────────────────────────────────────────────────────

const EMPTY_SUPPLIER = { name: "", contact: "", email: "", phone: "", active: true }

function SuppliersTab({ toast }: { toast: (t: "ok" | "err", m: string) => void }) {
  const supabase = createClient()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form, setForm] = useState(EMPTY_SUPPLIER)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from("suppliers").select("*").order("name")
    setSuppliers((data ?? []) as Supplier[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function openAdd() { setEditing(null); setForm(EMPTY_SUPPLIER); setDrawerOpen(true) }
  function openEdit(s: Supplier) {
    setEditing(s)
    setForm({ name: s.name, contact: s.contact ?? "", email: s.email ?? "", phone: s.phone ?? "", active: s.active })
    setDrawerOpen(true)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload = { name: form.name, contact: form.contact || null, email: form.email || null, phone: form.phone || null, active: form.active }
    const { error } = editing
      ? await supabase.from("suppliers").update(payload).eq("id", editing.id)
      : await supabase.from("suppliers").insert(payload)
    if (error) { toast("err", error.message) } else {
      toast("ok", editing ? "Supplier updated." : "Supplier added.")
      void logActivity({ action: editing ? "supplier_updated" : "supplier_created", module: "retail_settings", recordLabel: form.name })
      setDrawerOpen(false); load()
    }
    setSaving(false)
  }

  async function toggleActive(s: Supplier) {
    await supabase.from("suppliers").update({ active: !s.active }).eq("id", s.id)
    toast("ok", `${s.name} ${s.active ? "deactivated" : "activated"}.`)
    load()
  }

  return (
    <>
      <div className="flex justify-end mb-4">
        <button onClick={openAdd} className="btn-primary text-sm py-2 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Supplier
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-brand-700">
            <th className="text-left px-4 py-3 text-brand-400 font-medium">Name</th>
            <th className="text-left px-4 py-3 text-brand-400 font-medium">Contact person</th>
            <th className="text-left px-4 py-3 text-brand-400 font-medium">Phone</th>
            <th className="text-left px-4 py-3 text-brand-400 font-medium">Status</th>
            <th className="px-4 py-3" />
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={5} className="px-4 py-10 text-center text-brand-500">Loading…</td></tr>
              : suppliers.length === 0 ? <tr><td colSpan={5} className="px-4 py-10 text-center text-brand-500">No suppliers yet. Add one to get started.</td></tr>
              : suppliers.map((s) => (
              <tr key={s.id} className="border-b border-brand-800 hover:bg-brand-800/40 transition-colors">
                <td className="px-4 py-3 text-white font-medium">{s.name}</td>
                <td className="px-4 py-3 text-brand-400">{s.contact ?? "—"}</td>
                <td className="px-4 py-3 text-brand-400">{s.phone ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`badge border ${s.active ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-brand-700 text-brand-400 border-brand-600"}`}>
                    {s.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => openEdit(s)} className="btn-ghost text-xs py-1 px-2 border border-brand-700">Edit</button>
                    <button onClick={() => toggleActive(s)} className="btn-ghost text-xs py-1 px-2 border border-brand-700">
                      {s.active ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title={editing ? "Edit Supplier" : "Add Supplier"}>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Supplier name *</label>
            <input required type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. ABC Beauty Co." className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Contact person</label>
            <input type="text" value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="e.g. Somchai" className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Email</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="supplier@example.com" className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Phone</label>
            <input type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="e.g. 02-xxx-xxxx" className="input-field" />
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setForm({ ...form, active: !form.active })}
              className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${form.active ? "bg-emerald-500" : "bg-brand-700"}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-1 ${form.active ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            <span className="text-sm text-brand-300">Active</span>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving} className="btn-primary flex-1 py-2.5">{saving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => setDrawerOpen(false)} className="btn-ghost flex-1 py-2.5 border border-brand-700">Cancel</button>
          </div>
        </form>
      </Drawer>
    </>
  )
}

// ── Product tab (shared by FG + Consumables) ──────────────────────────────────

const EMPTY_PRODUCT = { sku: "", name: "", category: "", unit: "piece", reorder_threshold: "20", cost_price: "", selling_price: "", supplier: "", location: "" }

function ProductsTab({ type, title, toast }: { type: "fg" | "consumable"; title: string; toast: (t: "ok" | "err", m: string) => void }) {
  const supabase = createClient()
  const [products, setProducts] = useState<Product[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState(EMPTY_PRODUCT)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [prodRes, suppRes] = await Promise.all([
      supabase.from("products").select("*").eq("type", type).order("name"),
      supabase.from("suppliers").select("id, name").eq("active", true).order("name"),
    ])
    setProducts((prodRes.data ?? []) as Product[])
    setSuppliers((suppRes.data ?? []) as Supplier[])
    setLoading(false)
  }, [type])

  useEffect(() => { load() }, [load])

  function openAdd() {
    setEditing(null)
    setForm(EMPTY_PRODUCT)
    setDrawerOpen(true)
  }

  function openEdit(p: Product) {
    setEditing(p)
    setForm({
      sku: p.sku, name: p.name, category: p.category ?? "", unit: p.unit,
      reorder_threshold: String(p.reorder_threshold), cost_price: String(p.cost_price ?? ""),
      selling_price: String(p.selling_price ?? ""), supplier: p.supplier ?? "", location: p.location ?? "",
    })
    setDrawerOpen(true)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload = {
      sku: form.sku, name: form.name, category: form.category || null, unit: form.unit,
      reorder_threshold: parseInt(form.reorder_threshold) || 20,
      cost_price: form.cost_price ? parseFloat(form.cost_price) : null,
      selling_price: form.selling_price ? parseFloat(form.selling_price) : null,
      supplier: form.supplier || null, location: form.location || null, type,
    }
    const { error } = editing
      ? await supabase.from("products").update(payload).eq("id", editing.id)
      : await supabase.from("products").insert(payload)
    if (error) { toast("err", error.message) } else {
      toast("ok", editing ? "Product updated." : "Product added.")
      void logActivity({ action: editing ? "product_updated" : "product_created", module: "retail_settings", recordLabel: form.name })
      setDrawerOpen(false); load()
    }
    setSaving(false)
  }

  async function handleCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const lines = text.trim().split("\n")
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase())
    const rows = lines.slice(1).map((line) => {
      const vals = line.split(",")
      return Object.fromEntries(headers.map((h, i) => [h, vals[i]?.trim() ?? ""]))
    })
    const upserts = rows.filter((r) => r.sku && r.name).map((r) => ({
      sku: r.sku, name: r.name, category: r.category || null, unit: r.unit || "piece",
      reorder_threshold: parseInt(r.minimum || r.threshold || r.reorder_threshold) || 20,
      cost_price: r.cost_price ? parseFloat(r.cost_price) : null,
      selling_price: r.selling_price ? parseFloat(r.selling_price) : null,
      supplier: r.supplier || null, type,
    }))
    if (!upserts.length) { toast("err", "No valid rows found. Check CSV headers."); return }
    const { error } = await supabase.from("products").upsert(upserts, { onConflict: "sku" })
    if (error) { toast("err", error.message) } else { toast("ok", `Imported ${upserts.length} products.`); load() }
    if (fileRef.current) fileRef.current.value = ""
  }

  const f = (k: keyof typeof EMPTY_PRODUCT) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((p) => ({ ...p, [k]: e.target.value }))

  return (
    <>
      <div className="flex gap-2 justify-end mb-4">
        <button onClick={() => fileRef.current?.click()} className="btn-ghost border border-brand-700 text-sm py-2 px-3 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Import CSV
        </button>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleCSV} />
        <button onClick={openAdd} className="btn-primary text-sm py-2 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add {title}
        </button>
      </div>

      <p className="text-xs text-brand-600 mb-3">CSV columns: <code className="text-brand-500">sku, name, category, unit, minimum, cost_price, selling_price, supplier</code></p>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-brand-700">
              <th className="text-left px-4 py-3 text-brand-400 font-medium">SKU</th>
              <th className="text-left px-4 py-3 text-brand-400 font-medium">Name</th>
              <th className="text-left px-4 py-3 text-brand-400 font-medium">Category</th>
              <th className="text-left px-4 py-3 text-brand-400 font-medium">Unit</th>
              <th className="text-right px-4 py-3 text-brand-400 font-medium">Minimum</th>
              <th className="text-right px-4 py-3 text-brand-400 font-medium">Price</th>
              <th className="text-left px-4 py-3 text-brand-400 font-medium">Supplier</th>
              <th className="px-4 py-3" />
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={8} className="px-4 py-10 text-center text-brand-500">Loading…</td></tr>
                : products.length === 0 ? <tr><td colSpan={8} className="px-4 py-10 text-center text-brand-500">No {title.toLowerCase()} yet. Add one or import CSV.</td></tr>
                : products.map((p) => (
                <tr key={p.id} className="border-b border-brand-800 hover:bg-brand-800/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-brand-400">{p.sku}</td>
                  <td className="px-4 py-3 text-white font-medium">{p.name}</td>
                  <td className="px-4 py-3 text-brand-400">{p.category ?? "—"}</td>
                  <td className="px-4 py-3 text-brand-400">{p.unit}</td>
                  <td className="px-4 py-3 text-right text-brand-300">{p.reorder_threshold}</td>
                  <td className="px-4 py-3 text-right text-brand-300">{p.selling_price != null ? `฿${p.selling_price}` : "—"}</td>
                  <td className="px-4 py-3 text-brand-400">{p.supplier ?? "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(p)} className="btn-ghost text-xs py-1 px-2 border border-brand-700">Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title={editing ? `Edit ${title}` : `Add ${title}`}>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">SKU *</label>
              <input required type="text" value={form.sku} onChange={f("sku")} placeholder="KC-001" className="input-field" />
            </div>
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">Unit</label>
              <input type="text" value={form.unit} onChange={f("unit")} placeholder="piece" className="input-field" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Name *</label>
            <input required type="text" value={form.name} onChange={f("name")} placeholder="Product name" className="input-field" />
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Category</label>
            <input type="text" value={form.category} onChange={f("category")} placeholder="e.g. Skincare" className="input-field" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">Minimum stock</label>
              <input type="number" min="0" value={form.reorder_threshold} onChange={f("reorder_threshold")} className="input-field" />
            </div>
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">Selling price (฿)</label>
              <input type="number" min="0" step="0.01" value={form.selling_price} onChange={f("selling_price")} placeholder="0.00" className="input-field" />
            </div>
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">Cost price (฿)</label>
              <input type="number" min="0" step="0.01" value={form.cost_price} onChange={f("cost_price")} placeholder="0.00" className="input-field" />
            </div>
            <div>
              <label className="block text-sm font-medium text-brand-300 mb-1.5">Supplier</label>
              <select value={form.supplier} onChange={(e) => setForm((p) => ({ ...p, supplier: e.target.value }))} className="input-field">
                <option value="">None</option>
                {suppliers.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-brand-300 mb-1.5">Storage location</label>
            <input type="text" value={form.location} onChange={f("location")} placeholder="e.g. Warehouse A" className="input-field" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving} className="btn-primary flex-1 py-2.5">{saving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => setDrawerOpen(false)} className="btn-ghost flex-1 py-2.5 border border-brand-700">Cancel</button>
          </div>
        </form>
      </Drawer>
    </>
  )
}

// ── Stock Levels grid ─────────────────────────────────────────────────────────

type CellValue = { qty: string; min: string }

interface CsvRow {
  sku: string
  branchName: string
  qty: string
  minimum: string
  productId: string | null
  productName: string
  branchId: string | null
  valid: boolean
}

function StockLevelsTab({ toast }: { toast: (t: "ok" | "err", m: string) => void }) {
  const supabase = createClient()
  const [branches, setBranches] = useState<RetailBranch[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [grid, setGrid] = useState<Record<string, Record<string, CellValue>>>({})
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadKey, setLoadKey] = useState(0)

  const fileRef = useRef<HTMLInputElement>(null)
  const [csvPreview, setCsvPreview] = useState<CsvRow[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ ok: number; skipped: number } | null>(null)

  useEffect(() => {
    Promise.all([
      supabase.from("branches").select("*").eq("active", true).order("name"),
      supabase.from("products").select("*").eq("active", true).order("name"),
      supabase.from("stock_levels").select("product_id, branch_id, quantity, minimum_override"),
    ]).then(([b, p, s]) => {
      const branchList = (b.data ?? []) as RetailBranch[]
      const productList = (p.data ?? []) as Product[]
      const stockList = s.data ?? []
      setBranches(branchList)
      setProducts(productList)
      const g: Record<string, Record<string, CellValue>> = {}
      productList.forEach((prod) => {
        g[prod.id] = {}
        branchList.forEach((br) => { g[prod.id][br.id] = { qty: "", min: "" } })
      })
      stockList.forEach((sl: { product_id: string; branch_id: string; quantity: number; minimum_override: number | null }) => {
        if (g[sl.product_id]) {
          g[sl.product_id][sl.branch_id] = {
            qty: String(sl.quantity),
            min: sl.minimum_override != null ? String(sl.minimum_override) : "",
          }
        }
      })
      setGrid(g)
      setLoading(false)
    })
  }, [loadKey])

  function handleCell(productId: string, branchId: string, field: "qty" | "min", value: string) {
    setGrid((prev) => ({
      ...prev,
      [productId]: { ...prev[productId], [branchId]: { ...prev[productId][branchId], [field]: value } },
    }))
  }

  async function handleSaveAll() {
    setSaving(true)
    const upserts: { product_id: string; branch_id: string; quantity: number; minimum_override: number | null; updated_at: string }[] = []
    Object.entries(grid).forEach(([productId, byBranch]) => {
      Object.entries(byBranch).forEach(([branchId, cell]) => {
        if (cell.qty !== "" || cell.min !== "") {
          upserts.push({
            product_id: productId,
            branch_id: branchId,
            quantity: cell.qty !== "" ? parseInt(cell.qty) || 0 : 0,
            minimum_override: cell.min !== "" ? parseInt(cell.min) || null : null,
            updated_at: new Date().toISOString(),
          })
        }
      })
    })
    const { error } = await supabase.from("stock_levels").upsert(upserts, { onConflict: "product_id,branch_id" })
    if (error) { toast("err", error.message) } else { toast("ok", `Saved ${upserts.length} stock level entries.`) }
    setSaving(false)
  }

  function handleCSVFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvPreview(null)
    setImportResult(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? ""
      const lines = text.trim().split("\n").filter((l) => l.trim())
      if (lines.length < 2) { toast("err", "CSV must have a header row and at least one data row."); return }
      const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z_]/g, ""))
      const rows: CsvRow[] = lines.slice(1).map((line) => {
        const vals = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""))
        const obj: Record<string, string> = {}
        headers.forEach((h, i) => { obj[h] = vals[i] ?? "" })
        const sku = obj.sku ?? ""
        const branchName = obj.branch_name ?? obj.branch ?? ""
        const qty = obj.qty ?? obj.quantity ?? ""
        const minimum = obj.minimum ?? obj.min ?? ""
        const product = products.find((p) => p.sku === sku)
        const branch = branches.find((b) => b.name.toLowerCase() === branchName.toLowerCase())
        return {
          sku, branchName, qty, minimum,
          productId: product?.id ?? null,
          productName: product?.name ?? "— not found —",
          branchId: branch?.id ?? null,
          valid: !!product && !!branch,
        }
      })
      setCsvPreview(rows)
    }
    reader.readAsText(file)
    if (fileRef.current) fileRef.current.value = ""
  }

  async function confirmImport() {
    if (!csvPreview) return
    setImporting(true)
    const valid = csvPreview.filter((r) => r.valid)
    const skipped = csvPreview.length - valid.length
    if (valid.length === 0) { toast("err", "No valid rows to import."); setImporting(false); return }
    const upserts = valid.map((r) => ({
      product_id: r.productId!,
      branch_id: r.branchId!,
      quantity: r.qty !== "" ? parseInt(r.qty) || 0 : 0,
      minimum_override: r.minimum !== "" ? parseInt(r.minimum) || null : null,
      updated_at: new Date().toISOString(),
    }))
    const { error } = await supabase.from("stock_levels").upsert(upserts, { onConflict: "product_id,branch_id" })
    if (error) {
      toast("err", error.message)
    } else {
      toast("ok", `Imported ${valid.length} rows.${skipped > 0 ? ` ${skipped} skipped (not found).` : ""}`)
      setImportResult({ ok: valid.length, skipped })
      setCsvPreview(null)
      setLoadKey((k) => k + 1)
    }
    setImporting(false)
  }

  if (loading) return <p className="text-brand-500 text-sm text-center py-12">Loading…</p>

  return (
    <>
      <div className="flex items-start justify-between mb-4 gap-4">
        <p className="text-sm text-brand-400">Set opening stock quantities and branch-specific minimum levels. Branch minimum overrides the global product minimum for alerts.</p>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => fileRef.current?.click()}
            className="btn-ghost border border-brand-700 text-sm py-2 px-3 flex items-center gap-2"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Import CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleCSVFile} />
          <button onClick={handleSaveAll} disabled={saving} className="btn-primary text-sm py-2">
            {saving ? "Saving…" : "Save All"}
          </button>
        </div>
      </div>

      {/* CSV format hint */}
      <p className="text-xs text-brand-600 mb-3">CSV columns: <code className="text-brand-500">sku, branch_name, qty, minimum</code></p>

      {/* Import result banner */}
      {importResult && (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-950 border border-emerald-500/30 text-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-400 shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
          <span className="text-emerald-300">Imported {importResult.ok} rows successfully.</span>
          {importResult.skipped > 0 && <span className="text-amber-400">{importResult.skipped} skipped (SKU or branch not found).</span>}
          <button onClick={() => setImportResult(null)} className="ml-auto text-brand-500 hover:text-white text-xs">Dismiss</button>
        </div>
      )}

      {/* CSV preview & confirm */}
      {csvPreview && (
        <div className="mb-6 card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-brand-700">
            <div>
              <p className="text-white text-sm font-semibold">Import preview — {csvPreview.length} rows</p>
              <p className="text-brand-400 text-xs mt-0.5">
                {csvPreview.filter((r) => r.valid).length} valid · {csvPreview.filter((r) => !r.valid).length} will be skipped
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setCsvPreview(null)} className="btn-ghost text-xs py-1.5 px-3 border border-brand-700">Cancel</button>
              <button
                onClick={confirmImport}
                disabled={importing || csvPreview.filter((r) => r.valid).length === 0}
                className="btn-primary text-xs py-1.5 px-3"
              >
                {importing ? "Importing…" : `Confirm import (${csvPreview.filter((r) => r.valid).length})`}
              </button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-brand-800 z-10">
                <tr className="border-b border-brand-700">
                  <th className="text-left px-3 py-2 text-brand-400 font-medium">SKU</th>
                  <th className="text-left px-3 py-2 text-brand-400 font-medium">Product</th>
                  <th className="text-left px-3 py-2 text-brand-400 font-medium">Branch</th>
                  <th className="text-right px-3 py-2 text-brand-400 font-medium">Qty</th>
                  <th className="text-right px-3 py-2 text-brand-400 font-medium">Min</th>
                  <th className="text-center px-3 py-2 text-brand-400 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {csvPreview.map((row, i) => (
                  <tr key={i} className={`border-b border-brand-800 ${row.valid ? "" : "opacity-50"}`}>
                    <td className="px-3 py-1.5 font-mono text-brand-400">{row.sku}</td>
                    <td className="px-3 py-1.5 text-white">{row.productName}</td>
                    <td className="px-3 py-1.5 text-brand-300">{row.branchName || "—"}</td>
                    <td className="px-3 py-1.5 text-right text-brand-300">{row.qty || "—"}</td>
                    <td className="px-3 py-1.5 text-right text-amber-400">{row.minimum || "—"}</td>
                    <td className="px-3 py-1.5 text-center">
                      {row.valid
                        ? <span className="badge bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Ready</span>
                        : <span className="badge bg-red-500/10 text-red-400 border border-red-500/20">
                            {!row.productId ? "SKU not found" : "Branch not found"}
                          </span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brand-700">
                <th className="text-left px-4 py-3 text-brand-400 font-medium sticky left-0 bg-brand-800 z-10">Product</th>
                <th className="text-left px-3 py-3 text-brand-400 font-medium text-xs">Type</th>
                {branches.map((b) => (
                  <th key={b.id} className="text-center px-2 py-3 text-brand-400 font-medium min-w-[110px] text-xs">{b.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-brand-800 hover:bg-brand-800/20 transition-colors">
                  <td className="px-4 py-2 sticky left-0 bg-brand-900 z-10">
                    <p className="text-white text-sm font-medium">{p.name}</p>
                    <p className="text-brand-500 text-xs font-mono">{p.sku}</p>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`badge text-[10px] ${p.type === "fg" ? "bg-blue-500/10 text-blue-400 border-blue-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"} border`}>
                      {p.type === "fg" ? "FG" : "Consumable"}
                    </span>
                  </td>
                  {branches.map((b) => (
                    <td key={b.id} className="px-2 py-2 text-center">
                      <div className="flex flex-col gap-1 items-center">
                        <input
                          type="number"
                          min="0"
                          value={grid[p.id]?.[b.id]?.qty ?? ""}
                          onChange={(e) => handleCell(p.id, b.id, "qty", e.target.value)}
                          placeholder="Qty"
                          title="Opening stock quantity"
                          className="w-16 bg-brand-800 border border-brand-700 text-white text-center text-xs rounded-md px-1.5 py-1 outline-none focus:border-white focus:ring-1 focus:ring-white/20 transition-all"
                        />
                        <input
                          type="number"
                          min="0"
                          value={grid[p.id]?.[b.id]?.min ?? ""}
                          onChange={(e) => handleCell(p.id, b.id, "min", e.target.value)}
                          placeholder="Min"
                          title={`Branch minimum (global: ${p.reorder_threshold})`}
                          className="w-16 bg-brand-800 border border-amber-600/40 text-amber-300 text-center text-xs rounded-md px-1.5 py-1 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/20 transition-all"
                        />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 border-t border-brand-800 flex items-center gap-3 text-xs text-brand-500">
          <span className="inline-block w-3 h-3 rounded bg-brand-800 border border-brand-700 flex-shrink-0" /> Qty — opening stock
          <span className="inline-block w-3 h-3 rounded bg-brand-800 border border-amber-600/40 flex-shrink-0 ml-2" /> Min — branch minimum (overrides global)
        </div>
      </div>
    </>
  )
}

// ── Settings page ─────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { profile, loading: profileLoading } = useProfile()
  const [tab, setTab] = useState<Tab>("branches")
  const { toasts, show } = useToast()

  const isManager = profile?.portal_role === "admin" || profile?.portal_role === "manager" || profile?.portal_role === "superadmin"

  if (profileLoading) return <div className="flex items-center justify-center h-64 text-brand-400">Loading…</div>

  if (!isManager) return (
    <div className="flex items-center justify-center h-64 text-brand-400 flex-col gap-2">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      <p className="text-sm">Settings are accessible to managers and admins only.</p>
    </div>
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
        <PageHeader title="Settings" subtitle="Manage master data for Retail Ops" />

        {/* Tabs */}
        <div className="flex border-b border-brand-700 gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === t.key ? "border-white text-white" : "border-transparent text-brand-400 hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "branches"     && <BranchesTab toast={show} />}
        {tab === "suppliers"    && <SuppliersTab toast={show} />}
        {tab === "fg"           && <ProductsTab type="fg" title="Product" toast={show} />}
        {tab === "consumables"  && <ProductsTab type="consumable" title="Consumable" toast={show} />}
        {tab === "stock-levels" && <StockLevelsTab toast={show} />}
      </div>

      {/* Toast stack */}
      <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-50 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium border transition-all duration-300 ${
              t.type === "ok"
                ? "bg-emerald-950 border-emerald-500/30 text-emerald-300"
                : "bg-red-950 border-red-500/30 text-red-300"
            }`}
          >
            {t.type === "ok"
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            }
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
