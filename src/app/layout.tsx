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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Noto+Sans+Thai:wght@400;500&display=swap"
        />
      </head>
      {/* Banner sits above everything — including the login page, where
          confusing UAT for production is easiest to do. */}
      <body className="flex flex-col h-screen overflow-hidden">
        <EnvBanner />
        <div className="flex-1 min-h-0">{children}</div>
      </body>
    </html>
  )
}
