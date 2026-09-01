import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Store Operations",
  description: "Store operations system for Kind Collective",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
