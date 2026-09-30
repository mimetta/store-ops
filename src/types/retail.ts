export interface Supplier {
  id: string
  name: string
  contact: string | null
  email: string | null
  phone: string | null
  active: boolean
  created_at: string
}

export interface RetailBranch {
  id: string
  name: string
  location: string | null
  active: boolean
  /** own_store | consignment | popup | office — see lib/branches.ts */
  store_type: string | null
  created_at: string
}

export type ProductType = 'fg' | 'consumable'
export interface Product {
  id: string
  sku: string
  name: string
  // `barcode` used to be declared here. There is no such column on products —
  // barcodes are ours to own and have never been built — so every read of it
  // returned undefined and the stock screen's scanner could never match.
  // See GO-LIVE D6.
  category: string | null
  unit: string
  type: ProductType | null
  reorder_threshold: number
  cost_price: number | null
  selling_price: number | null
  supplier: string | null
  location: string | null
  active: boolean
  created_at: string
}

export interface StockLevel {
  /** Since 014 this, not branch_id, is what a level belongs to. */
  warehouse_id: string
  minimum_override: number | null
  id: string
  product_id: string
  branch_id: string
  quantity: number
  updated_at: string
  products?: Product
  branches?: RetailBranch
}

export type MovementType = 'in' | 'out' | 'adjustment'
export interface StockMovement {
  /** Since 014. The movement chain filters on it and skips a NULL silently. */
  warehouse_id: string | null
  id: string
  product_id: string
  branch_id: string
  movement_type: MovementType
  quantity: number
  reference: string | null
  notes: string | null
  created_by: string | null
  created_at: string
}

/**
 * One row per branch, per day, PER NATIONALITY — reshaped by migration 010.
 *
 * This interface still described the old two-column shape long after the table
 * changed, which is why the compiler was happy to let the traffic screen read
 * `thai_count` from a row that has no such column. A type that lies about the
 * schema is worse than no type: it converts a loud failure into a silent one.
 */
export interface ShopTraffic {
  id: string
  branch_id: string
  date: string
  nationality: string
  visitor_count: number
  notes: string | null
  submitted_by: string | null
  created_at: string
  branches?: RetailBranch
}

export type EventType = 'ma_visit' | 'appointment' | 'internal' | 'training' | 'other'
export interface CalendarEvent {
  id: string
  title: string
  event_type: EventType | null
  branch_id: string | null
  start_date: string
  end_date: string | null
  start_time: string | null
  end_time: string | null
  description: string | null
  created_by: string | null
  created_at: string
  branches?: RetailBranch
}

export type LeaveType = 'annual' | 'sick' | 'personal' | 'other'
export type LeaveStatus = 'pending' | 'approved' | 'rejected'
export interface LeaveRequest {
  id: string
  staff_id: string
  leave_type: LeaveType
  start_date: string
  end_date: string
  total_days: number
  reason: string | null
  status: LeaveStatus
  branch_id: string | null
  approved_by: string | null
  approved_at: string | null
  notes: string | null
  created_at: string
  profiles?: { full_name: string | null; nickname: string | null }
  branches?: { name: string }
}

export type ShiftType = 'am' | 'pm' | 'full' | 'off' | 'leave'
export interface WorkSchedule {
  id: string
  staff_id: string
  branch_id: string | null
  date: string
  shift: ShiftType | null
  notes: string | null
  created_by: string | null
}

export interface TrainingSession {
  id: string
  title: string
  description: string | null
  required_for: string
  created_by: string | null
  created_at: string
}

export type TrainingStatus = 'not_started' | 'in_progress' | 'completed'
export interface TrainingProgress {
  id: string
  session_id: string
  staff_id: string
  assigned_by: string | null
  status: TrainingStatus
  completed_at: string | null
  notes: string | null
  profiles?: { full_name: string | null; nickname: string | null }
  training_sessions?: TrainingSession
}
