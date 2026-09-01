"use client"

interface StoreOpsLogoProps {
  size?: number
  className?: string
  showText?: boolean
}

export default function StoreOpsLogo({ size = 32, className = "", showText = true }: StoreOpsLogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {/* Storefront mark */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Store Operations mark"
      >
        {/* Awning */}
        <path
          d="M4 6h24l2.5 6.5a4.2 4.2 0 0 1-8.2 1.4 4.2 4.2 0 0 1-8.3 0 4.2 4.2 0 0 1-8.3 0A4.2 4.2 0 0 1 1.5 12.5L4 6Z"
          fill="white"
          opacity="0.95"
        />
        {/* Shop body */}
        <path
          d="M5 15.5v10.5a1 1 0 0 0 1 1h20a1 1 0 0 0 1-1V15.5"
          stroke="white"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.95"
        />
        {/* Doorway */}
        <rect x="12.75" y="18.5" width="6.5" height="8.5" rx="0.8" fill="white" opacity="0.95" />
        <circle cx="17.6" cy="23" r="0.7" fill="#1E1C1A" />
      </svg>

      {showText && (
        <span className="font-semibold text-white tracking-wide" style={{ fontSize: size * 0.5 }}>
          Store Ops
        </span>
      )}
    </div>
  )
}
