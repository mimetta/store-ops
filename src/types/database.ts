// Must match the profiles.portal_role check constraint — verified by
// scripts/uat/check-type-drift.mjs. `staff` is retained because 003 kept it
// for rows that predate 005's migration to `ka`; it grants nothing.
//
// `superadmin` was removed by 054, which merged it into admin. It is NOT gone
// from the code: it stays in LEGACY_ROLES, where `can()` and `branchScope()`
// still treat it as a superset of admin. That matters because a database that
// has not yet run 054 still holds the row — dropping the handling as well as
// the type would lock that account out of every page between a deploy and the
// migration. The type says what the column may contain now; LEGACY_ROLES says
// what the code must still cope with.
export type PortalRole =
  | 'admin' | 'manager' | 'supervisor' | 'ka'
  | 'logistics' | 'people' | 'marketing' | 'staff' | 'inactive'
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'intern'
export type ServiceStatus = 'active' | 'building' | 'planned' | 'maintenance'
export type ServiceOpenIn = 'iframe' | 'link' | 'native'
export type AnnouncementCategory = 'general' | 'hr' | 'operations' | 'urgent' | 'event'

export interface Profile {
  id: string
  email: string
  full_name: string | null
  nickname: string | null
  chapter: string | null
  role: string | null
  branch_id: string | null
  employment_type: EmploymentType | null
  start_date: string | null
  line_manager_id: string | null
  portal_role: PortalRole
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export interface Chapter {
  id: string
  name: string
  color: string
  created_at: string
}

export interface Branch {
  id: string
  name: string
  location: string | null
  created_at: string
}

export interface Service {
  id: string
  name: string
  description: string | null
  url: string | null
  status: ServiceStatus
  icon: string | null
  category: string | null
  sort_order: number
  open_in: ServiceOpenIn
  created_at: string
}

export interface Announcement {
  id: string
  title: string
  body: string | null
  category: AnnouncementCategory
  posted_by: string | null
  is_pinned: boolean
  expires_at: string | null
  created_at: string
}

export interface News {
  id: string
  title: string
  body: string | null
  tag: string | null
  cover_url: string | null
  posted_by: string | null
  published_at: string
  created_at: string
}
