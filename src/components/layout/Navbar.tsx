"use client"

import StoreOpsLogo from "@/components/ui/StoreOpsLogo"
import { logout } from "@/app/login/actions"
import type { Profile } from "@/types/database"

interface NavbarProps {
  profile: Profile | null
}

export default function Navbar({ profile }: NavbarProps) {
  const initials = profile?.full_name
    ? profile.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()
    : profile?.email?.slice(0, 2).toUpperCase() ?? "??"

  return (
    <header className="h-14 bg-brand-950 border-b border-brand-800 flex items-center justify-between px-4 md:px-6 shrink-0 z-30 sticky top-0">
      <StoreOpsLogo size={28} />

      <div className="flex items-center gap-3">
        {/* User avatar / initials */}
        <div className="relative group">
          <button
            className="flex items-center gap-2 rounded-full focus:outline-none"
            aria-label="User menu"
          >
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-brand-900 bg-white shrink-0">
              {initials}
            </div>
            <span className="hidden md:block text-sm text-brand-300 max-w-[160px] truncate">
              {profile?.nickname ?? profile?.full_name ?? profile?.email}
            </span>
          </button>

          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-2 w-56 bg-brand-800 border border-brand-700 rounded-xl shadow-xl opacity-0 invisible group-focus-within:opacity-100 group-focus-within:visible transition-all duration-150 z-50">
            <div className="px-4 py-3 border-b border-brand-700">
              <p className="text-sm font-medium text-white truncate">
                {profile?.full_name ?? "Staff"}
              </p>
              <p className="text-xs text-brand-400 truncate">{profile?.email}</p>
            </div>
            <form action={logout}>
              <button
                type="submit"
                className="w-full text-left px-4 py-2.5 text-sm text-brand-300 hover:bg-brand-700 hover:text-white transition-colors duration-150 rounded-b-xl"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
    </header>
  )
}
