"use client"

import type { RetailBranch } from "@/types/retail"

interface Props {
  branches: RetailBranch[]
  value: string
  onChange: (id: string) => void
  allLabel?: string
  className?: string
}

export default function BranchSelect({ branches, value, onChange, allLabel = "All branches", className = "" }: Props) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`input-field w-auto pr-8 ${className}`}
    >
      <option value="">{allLabel}</option>
      {branches.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </select>
  )
}
