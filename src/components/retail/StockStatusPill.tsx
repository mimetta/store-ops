interface Props {
  quantity: number
  threshold: number
}

export default function StockStatusPill({ quantity, threshold }: Props) {
  const isOk = quantity >= threshold
  const isLow = quantity > 0 && quantity < threshold
  const isCritical = quantity === 0

  if (isCritical) return (
    <span className="badge bg-red-500/10 text-red-400 border border-red-500/20">Critical</span>
  )
  if (isLow) return (
    <span className="badge bg-amber-500/10 text-amber-400 border border-amber-500/20">Low</span>
  )
  if (isOk) return (
    <span className="badge bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">OK</span>
  )
  return null
}
