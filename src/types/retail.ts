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
  created_at: string
}

export type ProductType = 'fg' | 'consumable'
export interface Product {
  id: string
  sku: string
  name: string
  barcode: string | null
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

export interface ShopTraffic {
  id: string
  branch_id: string
  date: string
  thai_count: number
  foreigner_count: number
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
