import type { Metadata } from "next"
import "./globals.css"
import EnvBanner from "@/components/layout/EnvBanner"

export const metadata: Metadata = {
  title: "Store Operations",
  description: "Store operations system for Mimetta",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      {/* Banner sits above everything — including the login page, where
          confusing UAT for production is easiest to do. */}
      <body className="flex flex-col h-screen overflow-hidden">
        <EnvBanner />
        <div className="flex-1 min-h-0">{children}</div>
      </body>
    </html>
  )
}
