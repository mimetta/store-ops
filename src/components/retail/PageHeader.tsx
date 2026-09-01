interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: React.ReactNode
}

export default function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-3 mb-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-brand-500 mb-0.5">
          Retail Ops
        </p>
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="text-sm text-brand-400 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}
