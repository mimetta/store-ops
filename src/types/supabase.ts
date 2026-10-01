// GENERATED FILE — DO NOT EDIT.
//
// Produced by scripts/uat/gen-types.sh from the live UAT schema.
// Regenerate after every migration:  npm run types:generate
//
// Hand-written interfaces drift. src/types/retail.ts described shop_traffic
// as thai_count/foreigner_count for eight migrations after 010 reshaped it
// into one row per nationality, and the compiler cheerfully agreed — which
// is how two screens stayed broken without anyone noticing.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      activity_logs: {
        Row: {
          action: string
          branch_id: string | null
          created_at: string | null
          id: string
          module: string
          new_value: Json | null
          old_value: Json | null
          record_id: string | null
          record_label: string | null
          user_id: string | null
          user_name: string | null
        }
        Insert: {
          action: string
          branch_id?: string | null
          created_at?: string | null
          id?: string
          module: string
          new_value?: Json | null
          old_value?: Json | null
          record_id?: string | null
          record_label?: string | null
          user_id?: string | null
          user_name?: string | null
        }
        Update: {
          action?: string
          branch_id?: string | null
          created_at?: string | null
          id?: string
          module?: string
          new_value?: Json | null
          old_value?: Json | null
          record_id?: string | null
          record_label?: string | null
          user_id?: string | null
          user_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "activity_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          body: string | null
          category: string | null
          created_at: string | null
          expires_at: string | null
          id: string
          is_pinned: boolean | null
          posted_by: string | null
          title: string
        }
        Insert: {
          body?: string | null
          category?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: string
          is_pinned?: boolean | null
          posted_by?: string | null
          title: string
        }
        Update: {
          body?: string | null
          category?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: string
          is_pinned?: boolean | null
          posted_by?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcements_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      bill_nationalities: {
        Row: {
          bills: number
          branch_id: string
          entry_date: string
          id: string
          nationality: string
          recorded_at: string
          recorded_by: string | null
        }
        Insert: {
          bills: number
          branch_id: string
          entry_date: string
          id?: string
          nationality: string
          recorded_at?: string
          recorded_by?: string | null
        }
        Update: {
          bills?: number
          branch_id?: string
          entry_date?: string
          id?: string
          nationality?: string
          recorded_at?: string
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bill_nationalities_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bill_nationalities_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "bill_nationalities_nationality_fkey"
            columns: ["nationality"]
            isOneToOne: false
            referencedRelation: "nationalities"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "bill_nationalities_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bill_nationalities_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_monthly_goals: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          currency: string
          goal_amount: number
          id: string
          period_month: string
          source: string
          source_ref: string | null
          synced_at: string | null
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          goal_amount: number
          id?: string
          period_month: string
          source?: string
          source_ref?: string | null
          synced_at?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          goal_amount?: number
          id?: string
          period_month?: string
          source?: string
          source_ref?: string | null
          synced_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_monthly_goals_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_monthly_goals_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "branch_monthly_goals_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_monthly_goals_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          active: boolean | null
          created_at: string | null
          id: string
          location: string | null
          name: string
          pos_branch_code: string | null
          pos_export: boolean
          store_type: string
        }
        Insert: {
          active?: boolean | null
          created_at?: string | null
          id?: string
          location?: string | null
          name: string
          pos_branch_code?: string | null
          pos_export?: boolean
          store_type?: string
        }
        Update: {
          active?: boolean | null
          created_at?: string | null
          id?: string
          location?: string | null
          name?: string
          pos_branch_code?: string | null
          pos_export?: boolean
          store_type?: string
        }
        Relationships: []
      }
      calendar_events: {
        Row: {
          branch_id: string | null
          created_at: string | null
          created_by: string | null
          description: string | null
          end_date: string | null
          end_time: string | null
          event_type: string | null
          id: string
          start_date: string
          start_time: string | null
          title: string
        }
        Insert: {
          branch_id?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          end_date?: string | null
          end_time?: string | null
          event_type?: string | null
          id?: string
          start_date: string
          start_time?: string | null
          title: string
        }
        Update: {
          branch_id?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          end_date?: string | null
          end_time?: string | null
          event_type?: string | null
          id?: string
          start_date?: string
          start_time?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_events_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_events_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "calendar_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      chapters: {
        Row: {
          color: string | null
          created_at: string | null
          id: string
          name: string
        }
        Insert: {
          color?: string | null
          created_at?: string | null
          id?: string
          name: string
        }
        Update: {
          color?: string | null
          created_at?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      company_settings: {
        Row: {
          id: string
          key: string
          updated_at: string | null
          value: string | null
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string | null
          value?: string | null
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string | null
          value?: string | null
        }
        Relationships: []
      }
      countable_products: {
        Row: {
          count_frequency: string
          created_at: string
          notes: string | null
          sku: string
        }
        Insert: {
          count_frequency?: string
          created_at?: string
          notes?: string | null
          sku: string
        }
        Update: {
          count_frequency?: string
          created_at?: string
          notes?: string | null
          sku?: string
        }
        Relationships: []
      }
      daily_sales_summary: {
        Row: {
          branch_id: string | null
          created_at: string | null
          id: string
          pay_alipay: number | null
          pay_card: number | null
          pay_cash: number | null
          pay_other: number | null
          pay_transfer: number | null
          pay_wechat: number | null
          recorded_by: string | null
          sale_date: string
          total_amount: number
        }
        Insert: {
          branch_id?: string | null
          created_at?: string | null
          id?: string
          pay_alipay?: number | null
          pay_card?: number | null
          pay_cash?: number | null
          pay_other?: number | null
          pay_transfer?: number | null
          pay_wechat?: number | null
          recorded_by?: string | null
          sale_date?: string
          total_amount?: number
        }
        Update: {
          branch_id?: string | null
          created_at?: string | null
          id?: string
          pay_alipay?: number | null
          pay_card?: number | null
          pay_cash?: number | null
          pay_other?: number | null
          pay_transfer?: number | null
          pay_wechat?: number | null
          recorded_by?: string | null
          sale_date?: string
          total_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "daily_sales_summary_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_sales_summary_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "daily_sales_summary_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_sales_summary_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      deliveries: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          delivery_date: string
          id: string
          notes: string | null
          received_at: string | null
          received_by: string | null
          reference: string
          slot: string
          status: string
          updated_at: string
          warehouse_id: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          delivery_date?: string
          id?: string
          notes?: string | null
          received_at?: string | null
          received_by?: string | null
          reference: string
          slot?: string
          status?: string
          updated_at?: string
          warehouse_id: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          delivery_date?: string
          id?: string
          notes?: string | null
          received_at?: string | null
          received_by?: string | null
          reference?: string
          slot?: string
          status?: string
          updated_at?: string
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "deliveries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_difference_reasons: {
        Row: {
          active: boolean
          code: string
          label: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          code: string
          label: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          code?: string
          label?: string
          sort_order?: number
        }
        Relationships: []
      }
      delivery_lines: {
        Row: {
          created_at: string
          delivery_id: string
          difference: number | null
          expected_qty: number
          id: string
          note: string | null
          product_id: string
          reason_code: string | null
          received_qty: number | null
        }
        Insert: {
          created_at?: string
          delivery_id: string
          difference?: number | null
          expected_qty: number
          id?: string
          note?: string | null
          product_id: string
          reason_code?: string | null
          received_qty?: number | null
        }
        Update: {
          created_at?: string
          delivery_id?: string
          difference?: number | null
          expected_qty?: number
          id?: string
          note?: string | null
          product_id?: string
          reason_code?: string | null
          received_qty?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "delivery_lines_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "delivery_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_lines_reason_code_fkey"
            columns: ["reason_code"]
            isOneToOne: false
            referencedRelation: "delivery_difference_reasons"
            referencedColumns: ["code"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      erp_import_rows: {
        Row: {
          applied: boolean
          created_at: string
          id: string
          prod_code: string | null
          raw: Json
          reject_reason: string | null
          run_id: string
          wh_code: string | null
        }
        Insert: {
          applied?: boolean
          created_at?: string
          id?: string
          prod_code?: string | null
          raw: Json
          reject_reason?: string | null
          run_id: string
          wh_code?: string | null
        }
        Update: {
          applied?: boolean
          created_at?: string
          id?: string
          prod_code?: string | null
          raw?: Json
          reject_reason?: string | null
          run_id?: string
          wh_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "erp_import_rows_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "erp_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      erp_sync_runs: {
        Row: {
          endpoint: string
          error_code: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          page_count: number
          rows_applied: number
          rows_fetched: number
          rows_skipped: number
          started_at: string
          status: string
          triggered_by: string | null
        }
        Insert: {
          endpoint: string
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          page_count?: number
          rows_applied?: number
          rows_fetched?: number
          rows_skipped?: number
          started_at?: string
          status?: string
          triggered_by?: string | null
        }
        Update: {
          endpoint?: string
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          page_count?: number
          rows_applied?: number
          rows_fetched?: number
          rows_skipped?: number
          started_at?: string
          status?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "erp_sync_runs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "erp_sync_runs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      fg_stock_withdrawals: {
        Row: {
          approved_by: string | null
          branch_id: string | null
          created_at: string | null
          id: string
          lot_number: string
          notes: string | null
          product_id: string | null
          quantity: number
          requested_by: string | null
          status: string | null
          withdraw_date: string
        }
        Insert: {
          approved_by?: string | null
          branch_id?: string | null
          created_at?: string | null
          id?: string
          lot_number: string
          notes?: string | null
          product_id?: string | null
          quantity?: number
          requested_by?: string | null
          status?: string | null
          withdraw_date?: string
        }
        Update: {
          approved_by?: string | null
          branch_id?: string | null
          created_at?: string | null
          id?: string
          lot_number?: string
          notes?: string | null
          product_id?: string | null
          quantity?: number
          requested_by?: string | null
          status?: string | null
          withdraw_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "fg_stock_withdrawals_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fg_stock_withdrawals_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fg_stock_withdrawals_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fg_stock_withdrawals_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "fg_stock_withdrawals_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "fg_stock_withdrawals_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fg_stock_withdrawals_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fg_stock_withdrawals_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_requests: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          branch_id: string | null
          created_at: string | null
          end_date: string
          id: string
          leave_type: string
          notes: string | null
          reason: string | null
          staff_id: string | null
          start_date: string
          status: string | null
          total_days: number | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          branch_id?: string | null
          created_at?: string | null
          end_date: string
          id?: string
          leave_type: string
          notes?: string | null
          reason?: string | null
          staff_id?: string | null
          start_date: string
          status?: string | null
          total_days?: number | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          branch_id?: string | null
          created_at?: string | null
          end_date?: string
          id?: string
          leave_type?: string
          notes?: string | null
          reason?: string | null
          staff_id?: string | null
          start_date?: string
          status?: string | null
          total_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "leave_requests_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      nationalities: {
        Row: {
          active: boolean
          code: string
          label: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          code: string
          label: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          code?: string
          label?: string
          sort_order?: number
        }
        Relationships: []
      }
      news: {
        Row: {
          body: string | null
          cover_url: string | null
          created_at: string | null
          id: string
          posted_by: string | null
          published_at: string | null
          tag: string | null
          title: string
        }
        Insert: {
          body?: string | null
          cover_url?: string | null
          created_at?: string | null
          id?: string
          posted_by?: string | null
          published_at?: string | null
          tag?: string | null
          title: string
        }
        Update: {
          body?: string | null
          cover_url?: string | null
          created_at?: string | null
          id?: string
          posted_by?: string | null
          published_at?: string | null
          tag?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "news_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "news_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_money_records: {
        Row: {
          branch_id: string | null
          created_at: string | null
          denom_1: number | null
          denom_10: number | null
          denom_100: number | null
          denom_1000: number | null
          denom_20: number | null
          denom_5: number | null
          denom_50: number | null
          denom_500: number | null
          id: string
          pay_alipay: number | null
          pay_card: number | null
          pay_cash: number | null
          pay_other: number | null
          pay_transfer: number | null
          pay_wechat: number | null
          record_date: string
          recorded_by: string | null
          total_amount: number | null
        }
        Insert: {
          branch_id?: string | null
          created_at?: string | null
          denom_1?: number | null
          denom_10?: number | null
          denom_100?: number | null
          denom_1000?: number | null
          denom_20?: number | null
          denom_5?: number | null
          denom_50?: number | null
          denom_500?: number | null
          id?: string
          pay_alipay?: number | null
          pay_card?: number | null
          pay_cash?: number | null
          pay_other?: number | null
          pay_transfer?: number | null
          pay_wechat?: number | null
          record_date?: string
          recorded_by?: string | null
          total_amount?: number | null
        }
        Update: {
          branch_id?: string | null
          created_at?: string | null
          denom_1?: number | null
          denom_10?: number | null
          denom_100?: number | null
          denom_1000?: number | null
          denom_20?: number | null
          denom_5?: number | null
          denom_50?: number | null
          denom_500?: number | null
          id?: string
          pay_alipay?: number | null
          pay_card?: number | null
          pay_cash?: number | null
          pay_other?: number | null
          pay_transfer?: number | null
          pay_wechat?: number | null
          record_date?: string
          recorded_by?: string | null
          total_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_money_records_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_money_records_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "pos_money_records_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_money_records_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      product_groups: {
        Row: {
          count_frequency: string
          created_at: string
          group_code: string
          name: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          count_frequency?: string
          created_at?: string
          group_code: string
          name?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          count_frequency?: string
          created_at?: string
          group_code?: string
          name?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      product_pack_factors: {
        Row: {
          base_unit: string
          created_at: string
          factor: number | null
          filled_at: string | null
          filled_by: string | null
          notes: string | null
          pack_unit: string
          sku: string
        }
        Insert: {
          base_unit?: string
          created_at?: string
          factor?: number | null
          filled_at?: string | null
          filled_by?: string | null
          notes?: string | null
          pack_unit: string
          sku: string
        }
        Update: {
          base_unit?: string
          created_at?: string
          factor?: number | null
          filled_at?: string | null
          filled_by?: string | null
          notes?: string | null
          pack_unit?: string
          sku?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_pack_factors_filled_by_fkey"
            columns: ["filled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_pack_factors_filled_by_fkey"
            columns: ["filled_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_pack_factors_sku_fkey"
            columns: ["sku"]
            isOneToOne: true
            referencedRelation: "product_count_policy"
            referencedColumns: ["sku"]
          },
          {
            foreignKeyName: "product_pack_factors_sku_fkey"
            columns: ["sku"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["sku"]
          },
          {
            foreignKeyName: "product_pack_factors_sku_fkey"
            columns: ["sku"]
            isOneToOne: true
            referencedRelation: "sales_posted_today"
            referencedColumns: ["sku"]
          },
          {
            foreignKeyName: "product_pack_factors_sku_fkey"
            columns: ["sku"]
            isOneToOne: true
            referencedRelation: "stock_count_line_chain"
            referencedColumns: ["sku"]
          },
        ]
      }
      product_reorder_points: {
        Row: {
          count_frequency: string
          created_at: string
          filled_at: string | null
          filled_by: string | null
          notes: string | null
          product_id: string
          product_name: string
          reorder_point: number | null
          shop: string
          sku: string
          unit: string | null
          warehouse_id: string
        }
        Insert: {
          count_frequency: string
          created_at?: string
          filled_at?: string | null
          filled_by?: string | null
          notes?: string | null
          product_id: string
          product_name: string
          reorder_point?: number | null
          shop: string
          sku: string
          unit?: string | null
          warehouse_id: string
        }
        Update: {
          count_frequency?: string
          created_at?: string
          filled_at?: string | null
          filled_by?: string | null
          notes?: string | null
          product_id?: string
          product_name?: string
          reorder_point?: number | null
          shop?: string
          sku?: string
          unit?: string | null
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_reorder_points_filled_by_fkey"
            columns: ["filled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_reorder_points_filled_by_fkey"
            columns: ["filled_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_reorder_points_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "product_reorder_points_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_reorder_points_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          acccloud_master_id: number | null
          active: boolean | null
          category: string | null
          cost_price: number | null
          created_at: string | null
          group_code: string | null
          id: string
          last_synced_at: string | null
          location: string | null
          name: string
          raw: Json | null
          reorder_threshold: number | null
          selling_price: number | null
          sku: string
          source: string
          supplier: string | null
          type: string | null
          unit: string | null
          unit_name: string | null
        }
        Insert: {
          acccloud_master_id?: number | null
          active?: boolean | null
          category?: string | null
          cost_price?: number | null
          created_at?: string | null
          group_code?: string | null
          id?: string
          last_synced_at?: string | null
          location?: string | null
          name: string
          raw?: Json | null
          reorder_threshold?: number | null
          selling_price?: number | null
          sku: string
          source?: string
          supplier?: string | null
          type?: string | null
          unit?: string | null
          unit_name?: string | null
        }
        Update: {
          acccloud_master_id?: number | null
          active?: boolean | null
          category?: string | null
          cost_price?: number | null
          created_at?: string | null
          group_code?: string | null
          id?: string
          last_synced_at?: string | null
          location?: string | null
          name?: string
          raw?: Json | null
          reorder_threshold?: number | null
          selling_price?: number | null
          sku?: string
          source?: string
          supplier?: string | null
          type?: string | null
          unit?: string | null
          unit_name?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          branch_id: string | null
          chapter: string | null
          created_at: string | null
          email: string
          employment_type: string | null
          full_name: string | null
          id: string
          line_manager_id: string | null
          nickname: string | null
          portal_role: string | null
          role: string | null
          start_date: string | null
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          branch_id?: string | null
          chapter?: string | null
          created_at?: string | null
          email: string
          employment_type?: string | null
          full_name?: string | null
          id: string
          line_manager_id?: string | null
          nickname?: string | null
          portal_role?: string | null
          role?: string | null
          start_date?: string | null
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          branch_id?: string | null
          chapter?: string | null
          created_at?: string | null
          email?: string
          employment_type?: string | null
          full_name?: string | null
          id?: string
          line_manager_id?: string | null
          nickname?: string | null
          portal_role?: string | null
          role?: string | null
          start_date?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "profiles_chapter_fkey"
            columns: ["chapter"]
            isOneToOne: false
            referencedRelation: "chapters"
            referencedColumns: ["name"]
          },
          {
            foreignKeyName: "profiles_line_manager_id_fkey"
            columns: ["line_manager_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_line_manager_id_fkey"
            columns: ["line_manager_id"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      role_capabilities: {
        Row: {
          capability: string
          role: string
        }
        Insert: {
          capability: string
          role: string
        }
        Update: {
          capability?: string
          role?: string
        }
        Relationships: []
      }
      roles: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          is_global: boolean | null
          name: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_global?: boolean | null
          name: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_global?: boolean | null
          name?: string
        }
        Relationships: []
      }
      sales_bill_lines: {
        Row: {
          bill_id: string
          id: string
          line_no: number
          net_amount: number
          product_id: string | null
          quantity: number
          sku_text: string
        }
        Insert: {
          bill_id: string
          id?: string
          line_no: number
          net_amount?: number
          product_id?: string | null
          quantity?: number
          sku_text: string
        }
        Update: {
          bill_id?: string
          id?: string
          line_no?: number
          net_amount?: number
          product_id?: string | null
          quantity?: number
          sku_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_bill_lines_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "sales_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_bill_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "sales_bill_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_bill_payments: {
        Row: {
          amount: number
          bank: string | null
          bill_id: string
          id: string
          line_no: number
          method: string
          reference: string | null
        }
        Insert: {
          amount?: number
          bank?: string | null
          bill_id: string
          id?: string
          line_no?: number
          method: string
          reference?: string | null
        }
        Update: {
          amount?: number
          bank?: string | null
          bill_id?: string
          id?: string
          line_no?: number
          method?: string
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_bill_payments_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "sales_bills"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_bills: {
        Row: {
          bill_date: string
          bill_number: string
          branch_id: string
          created_at: string
          discount_amount: number | null
          discount_pct: number | null
          gross_amount: number | null
          id: string
          import_id: string | null
          is_vip: boolean | null
          net_amount: number
          payment_method: string | null
          updated_at: string
        }
        Insert: {
          bill_date: string
          bill_number: string
          branch_id: string
          created_at?: string
          discount_amount?: number | null
          discount_pct?: number | null
          gross_amount?: number | null
          id?: string
          import_id?: string | null
          is_vip?: boolean | null
          net_amount?: number
          payment_method?: string | null
          updated_at?: string
        }
        Update: {
          bill_date?: string
          bill_number?: string
          branch_id?: string
          created_at?: string
          discount_amount?: number | null
          discount_pct?: number | null
          gross_amount?: number | null
          id?: string
          import_id?: string | null
          is_vip?: boolean | null
          net_amount?: number
          payment_method?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_bills_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_bills_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "sales_bills_import_id_fkey"
            columns: ["import_id"]
            isOneToOne: false
            referencedRelation: "sales_imports"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_import_mappings: {
        Row: {
          branch_id: string
          column_map: Json
          created_at: string
          created_by: string | null
          format_label: string
          header_signature: string | null
          id: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          column_map: Json
          created_at?: string
          created_by?: string | null
          format_label?: string
          header_signature?: string | null
          id?: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          column_map?: Json
          created_at?: string
          created_by?: string | null
          format_label?: string
          header_signature?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sales_import_mappings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: true
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_import_mappings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: true
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "sales_import_mappings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_import_mappings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_imports: {
        Row: {
          bills_inserted: number
          bills_updated: number
          branch_id: string
          file_name: string
          id: string
          imported_at: string
          imported_by: string | null
          lines_written: number
          period_end: string | null
          period_start: string | null
          rows_read: number
          unmatched_skus: string[]
        }
        Insert: {
          bills_inserted?: number
          bills_updated?: number
          branch_id: string
          file_name: string
          id?: string
          imported_at?: string
          imported_by?: string | null
          lines_written?: number
          period_end?: string | null
          period_start?: string | null
          rows_read?: number
          unmatched_skus?: string[]
        }
        Update: {
          bills_inserted?: number
          bills_updated?: number
          branch_id?: string
          file_name?: string
          id?: string
          imported_at?: string
          imported_by?: string | null
          lines_written?: number
          period_end?: string | null
          period_start?: string | null
          rows_read?: number
          unmatched_skus?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "sales_imports_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_imports_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "sales_imports_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_imports_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_posting_lines: {
        Row: {
          created_at: string
          id: string
          posting_id: string
          product_id: string
          units_sold: number
        }
        Insert: {
          created_at?: string
          id?: string
          posting_id: string
          product_id: string
          units_sold: number
        }
        Update: {
          created_at?: string
          id?: string
          posting_id?: string
          product_id?: string
          units_sold?: number
        }
        Relationships: [
          {
            foreignKeyName: "sales_posting_lines_posting_id_fkey"
            columns: ["posting_id"]
            isOneToOne: false
            referencedRelation: "sales_postings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_posting_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "sales_posting_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_postings: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          posted_at: string | null
          posted_by: string | null
          sale_date: string
          warehouse_id: string | null
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          posted_at?: string | null
          posted_by?: string | null
          sale_date?: string
          warehouse_id?: string | null
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          posted_at?: string | null
          posted_by?: string | null
          sale_date?: string
          warehouse_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_postings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_postings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "sales_postings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_postings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_postings_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_postings_posted_by_fkey"
            columns: ["posted_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_postings_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_records: {
        Row: {
          branch_id: string | null
          created_at: string | null
          id: string
          product_id: string | null
          recorded_by: string | null
          sale_date: string
          units_sold: number
        }
        Insert: {
          branch_id?: string | null
          created_at?: string | null
          id?: string
          product_id?: string | null
          recorded_by?: string | null
          sale_date?: string
          units_sold?: number
        }
        Update: {
          branch_id?: string | null
          created_at?: string | null
          id?: string
          product_id?: string | null
          recorded_by?: string | null
          sale_date?: string
          units_sold?: number
        }
        Relationships: [
          {
            foreignKeyName: "sales_records_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_records_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "sales_records_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "sales_records_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_records_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_records_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          category: string | null
          created_at: string | null
          description: string | null
          icon: string | null
          id: string
          name: string
          open_in: string | null
          sort_order: number | null
          status: string | null
          url: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          name: string
          open_in?: string | null
          sort_order?: number | null
          status?: string | null
          url?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          name?: string
          open_in?: string | null
          sort_order?: number | null
          status?: string | null
          url?: string | null
        }
        Relationships: []
      }
      shift_swap_days: {
        Row: {
          counterparty_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          lapses_at: string
          manager_decision: string
          request_id: string
          responded_at: string | null
          shift_start_at: string
          shift_template_id: string | null
          state: string
          work_date: string
        }
        Insert: {
          counterparty_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          lapses_at: string
          manager_decision?: string
          request_id: string
          responded_at?: string | null
          shift_start_at: string
          shift_template_id?: string | null
          state?: string
          work_date: string
        }
        Update: {
          counterparty_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          lapses_at?: string
          manager_decision?: string
          request_id?: string
          responded_at?: string | null
          shift_start_at?: string
          shift_template_id?: string | null
          state?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_swap_days_counterparty_id_fkey"
            columns: ["counterparty_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swap_days_counterparty_id_fkey"
            columns: ["counterparty_id"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swap_days_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swap_days_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swap_days_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "shift_swap_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swap_days_shift_template_id_fkey"
            columns: ["shift_template_id"]
            isOneToOne: false
            referencedRelation: "shift_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_swap_requests: {
        Row: {
          branch_id: string
          created_at: string
          id: string
          reason: string | null
          requester_id: string
          status: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          id?: string
          reason?: string | null
          requester_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          id?: string
          reason?: string | null
          requester_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_swap_requests_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swap_requests_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "shift_swap_requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swap_requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_templates: {
        Row: {
          active: boolean
          branch_id: string | null
          created_at: string
          created_by: string | null
          crosses_midnight: boolean
          end_time: string
          id: string
          name: string
          sort_order: number
          start_time: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          crosses_midnight?: boolean
          end_time: string
          id?: string
          name: string
          sort_order?: number
          start_time: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          crosses_midnight?: boolean
          end_time?: string
          id?: string
          name?: string
          sort_order?: number
          start_time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_templates_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "shift_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_traffic: {
        Row: {
          branch_id: string | null
          created_at: string | null
          date: string
          id: string
          nationality: string
          notes: string | null
          submitted_by: string | null
          visitor_count: number
        }
        Insert: {
          branch_id?: string | null
          created_at?: string | null
          date: string
          id?: string
          nationality: string
          notes?: string | null
          submitted_by?: string | null
          visitor_count?: number
        }
        Update: {
          branch_id?: string | null
          created_at?: string | null
          date?: string
          id?: string
          nationality?: string
          notes?: string | null
          submitted_by?: string | null
          visitor_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "shop_traffic_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_traffic_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "shop_traffic_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_traffic_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_adjustments: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          branch_id: string
          count_line_id: string | null
          id: string
          movement_id: string | null
          product_id: string
          qty_delta: number
          reason: string
          requested_at: string
          requested_by: string | null
          status: string
          warehouse_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          branch_id: string
          count_line_id?: string | null
          id?: string
          movement_id?: string | null
          product_id: string
          qty_delta: number
          reason: string
          requested_at?: string
          requested_by?: string | null
          status?: string
          warehouse_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          branch_id?: string
          count_line_id?: string | null
          id?: string
          movement_id?: string | null
          product_id?: string
          qty_delta?: number
          reason?: string
          requested_at?: string
          requested_by?: string | null
          status?: string
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_adjustments_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "stock_adjustments_count_line_id_fkey"
            columns: ["count_line_id"]
            isOneToOne: false
            referencedRelation: "stock_count_line_chain"
            referencedColumns: ["line_id"]
          },
          {
            foreignKeyName: "stock_adjustments_count_line_id_fkey"
            columns: ["count_line_id"]
            isOneToOne: false
            referencedRelation: "stock_count_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_movement_id_fkey"
            columns: ["movement_id"]
            isOneToOne: false
            referencedRelation: "stock_movements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "stock_adjustments_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_count_lines: {
        Row: {
          count_id: string
          counted_at: string | null
          counted_by: string | null
          counted_qty: number | null
          created_at: string
          explained_at: string | null
          explained_by: string | null
          explanation_state: string
          id: string
          product_id: string
          recounted_at: string | null
          recounted_by: string | null
          recounted_qty: number | null
          skip_reason: string | null
          skipped: boolean
          skipped_at: string | null
          skipped_by: string | null
          system_qty: number
          variance: number | null
          variance_reason: string | null
        }
        Insert: {
          count_id: string
          counted_at?: string | null
          counted_by?: string | null
          counted_qty?: number | null
          created_at?: string
          explained_at?: string | null
          explained_by?: string | null
          explanation_state?: string
          id?: string
          product_id: string
          recounted_at?: string | null
          recounted_by?: string | null
          recounted_qty?: number | null
          skip_reason?: string | null
          skipped?: boolean
          skipped_at?: string | null
          skipped_by?: string | null
          system_qty?: number
          variance?: number | null
          variance_reason?: string | null
        }
        Update: {
          count_id?: string
          counted_at?: string | null
          counted_by?: string | null
          counted_qty?: number | null
          created_at?: string
          explained_at?: string | null
          explained_by?: string | null
          explanation_state?: string
          id?: string
          product_id?: string
          recounted_at?: string | null
          recounted_by?: string | null
          recounted_qty?: number | null
          skip_reason?: string | null
          skipped?: boolean
          skipped_at?: string | null
          skipped_by?: string | null
          system_qty?: number
          variance?: number | null
          variance_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "stock_count_progress"
            referencedColumns: ["count_id"]
          },
          {
            foreignKeyName: "stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "stock_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_counted_by_fkey"
            columns: ["counted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_counted_by_fkey"
            columns: ["counted_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_explained_by_fkey"
            columns: ["explained_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_explained_by_fkey"
            columns: ["explained_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "stock_count_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_recounted_by_fkey"
            columns: ["recounted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_recounted_by_fkey"
            columns: ["recounted_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_skipped_by_fkey"
            columns: ["skipped_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_skipped_by_fkey"
            columns: ["skipped_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_counts: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          branch_id: string
          count_date: string
          counted_by: string | null
          created_at: string
          id: string
          notes: string | null
          status: string
          submitted_at: string | null
          updated_at: string
          warehouse_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          branch_id: string
          count_date?: string
          counted_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
          warehouse_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          branch_id?: string
          count_date?: string
          counted_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          status?: string
          submitted_at?: string | null
          updated_at?: string
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_counts_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "stock_counts_counted_by_fkey"
            columns: ["counted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_counted_by_fkey"
            columns: ["counted_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_discrepancies: {
        Row: {
          delivery_line_id: string | null
          id: string
          raised_at: string
          raised_by: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          transfer_line_id: string | null
        }
        Insert: {
          delivery_line_id?: string | null
          id?: string
          raised_at?: string
          raised_by?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          transfer_line_id?: string | null
        }
        Update: {
          delivery_line_id?: string | null
          id?: string
          raised_at?: string
          raised_by?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          transfer_line_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "delivery_shortages_delivery_line_id_fkey"
            columns: ["delivery_line_id"]
            isOneToOne: true
            referencedRelation: "delivery_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_shortages_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_shortages_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_shortages_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_shortages_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_discrepancies_transfer_line_id_fkey"
            columns: ["transfer_line_id"]
            isOneToOne: false
            referencedRelation: "transfer_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_levels: {
        Row: {
          branch_id: string | null
          id: string
          minimum_override: number | null
          product_id: string | null
          quantity: number | null
          updated_at: string | null
          warehouse_id: string
        }
        Insert: {
          branch_id?: string | null
          id?: string
          minimum_override?: number | null
          product_id?: string | null
          quantity?: number | null
          updated_at?: string | null
          warehouse_id: string
        }
        Update: {
          branch_id?: string | null
          id?: string
          minimum_override?: number | null
          product_id?: string | null
          quantity?: number | null
          updated_at?: string | null
          warehouse_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_levels_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_levels_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "stock_levels_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "stock_levels_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_levels_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          branch_id: string | null
          created_at: string | null
          created_by: string | null
          id: string
          movement_type: string | null
          notes: string | null
          product_id: string | null
          quantity: number
          reference: string | null
          sales_bill_id: string | null
          warehouse_id: string | null
        }
        Insert: {
          branch_id?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          movement_type?: string | null
          notes?: string | null
          product_id?: string | null
          quantity: number
          reference?: string | null
          sales_bill_id?: string | null
          warehouse_id?: string | null
        }
        Update: {
          branch_id?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          movement_type?: string | null
          notes?: string | null
          product_id?: string | null
          quantity?: number
          reference?: string | null
          sales_bill_id?: string | null
          warehouse_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "stock_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "stock_movements_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_sales_bill_id_fkey"
            columns: ["sales_bill_id"]
            isOneToOne: false
            referencedRelation: "sales_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          active: boolean | null
          contact: string | null
          created_at: string | null
          email: string | null
          id: string
          name: string
          phone: string | null
        }
        Insert: {
          active?: boolean | null
          contact?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name: string
          phone?: string | null
        }
        Update: {
          active?: boolean | null
          contact?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
        }
        Relationships: []
      }
      training_progress: {
        Row: {
          assigned_by: string | null
          completed_at: string | null
          id: string
          notes: string | null
          session_id: string | null
          staff_id: string | null
          status: string | null
        }
        Insert: {
          assigned_by?: string | null
          completed_at?: string | null
          id?: string
          notes?: string | null
          session_id?: string | null
          staff_id?: string | null
          status?: string | null
        }
        Update: {
          assigned_by?: string | null
          completed_at?: string | null
          id?: string
          notes?: string | null
          session_id?: string | null
          staff_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "training_progress_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_progress_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_progress_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "training_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_progress_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_progress_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      training_sessions: {
        Row: {
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string
          required_for: string | null
          title: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          required_for?: string | null
          title: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          required_for?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "training_sessions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_sessions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      transfer_lines: {
        Row: {
          created_at: string
          difference: number | null
          id: string
          note: string | null
          product_id: string
          reason_code: string | null
          received_qty: number | null
          sent_qty: number
          transfer_id: string
        }
        Insert: {
          created_at?: string
          difference?: number | null
          id?: string
          note?: string | null
          product_id: string
          reason_code?: string | null
          received_qty?: number | null
          sent_qty: number
          transfer_id: string
        }
        Update: {
          created_at?: string
          difference?: number | null
          id?: string
          note?: string | null
          product_id?: string
          reason_code?: string | null
          received_qty?: number | null
          sent_qty?: number
          transfer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transfer_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "transfer_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_lines_reason_code_fkey"
            columns: ["reason_code"]
            isOneToOne: false
            referencedRelation: "delivery_difference_reasons"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "transfer_lines_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "transfers"
            referencedColumns: ["id"]
          },
        ]
      }
      transfers: {
        Row: {
          created_at: string
          from_branch_id: string
          from_warehouse_id: string
          id: string
          note: string | null
          received_at: string | null
          received_by: string | null
          reference: string
          sent_at: string | null
          sent_by: string | null
          status: string
          to_branch_id: string | null
          to_warehouse_id: string
          transfer_date: string
        }
        Insert: {
          created_at?: string
          from_branch_id: string
          from_warehouse_id: string
          id?: string
          note?: string | null
          received_at?: string | null
          received_by?: string | null
          reference: string
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          to_branch_id?: string | null
          to_warehouse_id: string
          transfer_date?: string
        }
        Update: {
          created_at?: string
          from_branch_id?: string
          from_warehouse_id?: string
          id?: string
          note?: string | null
          received_at?: string | null
          received_by?: string | null
          reference?: string
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          to_branch_id?: string | null
          to_warehouse_id?: string
          transfer_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "transfers_from_branch_id_fkey"
            columns: ["from_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfers_from_branch_id_fkey"
            columns: ["from_branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "transfers_from_warehouse_id_fkey"
            columns: ["from_warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfers_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfers_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfers_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfers_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfers_to_branch_id_fkey"
            columns: ["to_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfers_to_branch_id_fkey"
            columns: ["to_branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "transfers_to_warehouse_id_fkey"
            columns: ["to_warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      user_departments: {
        Row: {
          created_at: string | null
          department_id: string | null
          id: string
          role_in_department: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          department_id?: string | null
          id?: string
          role_in_department?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          department_id?: string | null
          id?: string
          role_in_department?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_departments_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_departments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_departments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      warehouses: {
        Row: {
          active: boolean
          branch_id: string | null
          created_at: string
          id: string
          in_scope: boolean
          is_default: boolean
          name: string
          notes: string | null
          updated_at: string
          wh_code: string
        }
        Insert: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          id?: string
          in_scope?: boolean
          is_default?: boolean
          name: string
          notes?: string | null
          updated_at?: string
          wh_code: string
        }
        Update: {
          active?: boolean
          branch_id?: string | null
          created_at?: string
          id?: string
          in_scope?: boolean
          is_default?: boolean
          name?: string
          notes?: string | null
          updated_at?: string
          wh_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "warehouses_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warehouses_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
        ]
      }
      work_schedules: {
        Row: {
          branch_id: string | null
          created_by: string | null
          date: string
          id: string
          notes: string | null
          published_at: string | null
          published_by: string | null
          shift: string | null
          shift_template_id: string | null
          staff_id: string | null
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          created_by?: string | null
          date: string
          id?: string
          notes?: string | null
          published_at?: string | null
          published_by?: string | null
          shift?: string | null
          shift_template_id?: string | null
          staff_id?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          created_by?: string | null
          date?: string
          id?: string
          notes?: string | null
          published_at?: string | null
          published_by?: string | null
          shift?: string | null
          shift_template_id?: string | null
          staff_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_schedules_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_schedules_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "work_schedules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_schedules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_schedules_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_schedules_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_schedules_shift_template_id_fkey"
            columns: ["shift_template_id"]
            isOneToOne: false
            referencedRelation: "shift_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_schedules_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_schedules_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      branch_daily_metrics: {
        Row: {
          bills: number | null
          branch_id: string | null
          branch_name: string | null
          metric_date: string | null
          pos_fed: boolean | null
          sales: number | null
          sales_excl_vip: number | null
          sales_value_available: boolean | null
          store_type: string | null
          units: number | null
          vip_sales: number | null
          visitors: number | null
        }
        Relationships: []
      }
      branch_product_units: {
        Row: {
          branch_id: string | null
          metric_date: string | null
          product_id: string | null
          product_name: string | null
          sku: string | null
          unit: string | null
          units: number | null
        }
        Relationships: []
      }
      daily_entry_status: {
        Row: {
          attributed_bills: number | null
          branch_id: string | null
          branch_name: string | null
          entry_date: string | null
          imported_bills: number | null
          pos_fed: boolean | null
          units_keyed: number | null
          visitors: number | null
        }
        Relationships: []
      }
      pack_factors_outstanding: {
        Row: {
          name: string | null
          notes: string | null
          pack_unit: string | null
          sku: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_pack_factors_sku_fkey"
            columns: ["sku"]
            isOneToOne: true
            referencedRelation: "product_count_policy"
            referencedColumns: ["sku"]
          },
          {
            foreignKeyName: "product_pack_factors_sku_fkey"
            columns: ["sku"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["sku"]
          },
          {
            foreignKeyName: "product_pack_factors_sku_fkey"
            columns: ["sku"]
            isOneToOne: true
            referencedRelation: "sales_posted_today"
            referencedColumns: ["sku"]
          },
          {
            foreignKeyName: "product_pack_factors_sku_fkey"
            columns: ["sku"]
            isOneToOne: true
            referencedRelation: "stock_count_line_chain"
            referencedColumns: ["sku"]
          },
        ]
      }
      product_count_policy: {
        Row: {
          count_frequency: string | null
          decided_by: string | null
          group_code: string | null
          product_id: string | null
          sku: string | null
        }
        Relationships: []
      }
      reorder_points_outstanding: {
        Row: {
          count_frequency: string | null
          filled: number | null
          outstanding: number | null
          rows: number | null
          shop: string | null
        }
        Relationships: []
      }
      roster_staff: {
        Row: {
          branch_id: string | null
          branch_name: string | null
          full_name: string | null
          id: string | null
          nickname: string | null
          portal_role: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
        ]
      }
      sales_posted_today: {
        Row: {
          batches: number | null
          branch_id: string | null
          last_posted_at: string | null
          name: string | null
          product_id: string | null
          sale_date: string | null
          sku: string | null
          unit: string | null
          units_sold: number | null
          warehouse_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_posting_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "sales_posting_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_postings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_postings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "sales_postings_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_units_by_day: {
        Row: {
          bills: number | null
          branch_id: string | null
          gross_amount: number | null
          product_id: string | null
          sale_date: string | null
          sku_text: string | null
          units_sold: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_bill_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "sales_bill_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_bills_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_bills_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
        ]
      }
      stock_below_reorder_point: {
        Row: {
          count_frequency: string | null
          on_hand: number | null
          product_id: string | null
          product_name: string | null
          reorder_point: number | null
          shop: string | null
          short_by: number | null
          sku: string | null
          unit: string | null
          warehouse_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_levels_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "stock_levels_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_levels_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_count_line_chain: {
        Row: {
          count_id: string | null
          counted_qty: number | null
          explained_by: string | null
          explanation_state: string | null
          line_id: string | null
          name: string | null
          out_qty: number | null
          prev_date: string | null
          product_id: string | null
          received_qty: number | null
          recounted_by: string | null
          should_be_qty: number | null
          sku: string | null
          unit: string | null
          variance: number | null
          variance_reason: string | null
          yesterday_qty: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "stock_count_progress"
            referencedColumns: ["count_id"]
          },
          {
            foreignKeyName: "stock_count_lines_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "stock_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_explained_by_fkey"
            columns: ["explained_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_explained_by_fkey"
            columns: ["explained_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_count_policy"
            referencedColumns: ["product_id"]
          },
          {
            foreignKeyName: "stock_count_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_recounted_by_fkey"
            columns: ["recounted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_recounted_by_fkey"
            columns: ["recounted_by"]
            isOneToOne: false
            referencedRelation: "roster_staff"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_count_progress: {
        Row: {
          branch_id: string | null
          count_date: string | null
          count_id: string | null
          counted_lines: number | null
          is_complete: boolean | null
          outstanding_lines: number | null
          skipped_lines: number | null
          status: string | null
          total_lines: number | null
          warehouse_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_counts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "daily_entry_status"
            referencedColumns: ["branch_id"]
          },
          {
            foreignKeyName: "stock_counts_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      unresolved_countable_products: {
        Row: {
          count_frequency: string | null
          listed_code: string | null
          notes: string | null
        }
        Insert: {
          count_frequency?: string | null
          listed_code?: string | null
          notes?: string | null
        }
        Update: {
          count_frequency?: string | null
          listed_code?: string | null
          notes?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      approve_stock_adjustment: {
        Args: { p_adjustment: string }
        Returns: string
      }
      auth_branch_id: { Args: never; Returns: string }
      auth_portal_role: { Args: never; Returns: string }
      branch_has_erp_balance: { Args: { p_branch: string }; Returns: boolean }
      branch_is_pos_fed: { Args: { p_branch: string }; Returns: boolean }
      business_today: { Args: never; Returns: string }
      can_access_branch: { Args: { target: string }; Returns: boolean }
      copy_roster_from_previous: {
        Args: { p_branch: string; p_month: string }
        Returns: number
      }
      count_unresolved_lines: { Args: { p_count: string }; Returns: number }
      dashboard_availability: {
        Args: never
        Returns: {
          goals_available: boolean
          npd_available: boolean
          sales_branches: number
          shifts_available: boolean
          total_branches: number
          traffic_available: boolean
        }[]
      }
      default_warehouse_for_branch: {
        Args: { p_branch: string }
        Returns: string
      }
      discard_roster_draft: {
        Args: { p_branch: string; p_month: string }
        Returns: number
      }
      has_capability: { Args: { cap: string }; Returns: boolean }
      import_sales_bills: {
        Args: { p_bills: Json; p_branch: string; p_import: string }
        Returns: {
          bills_inserted: number
          bills_updated: number
          lines_written: number
          moved_stock: boolean
          payments_written: number
          units_out: number
        }[]
      }
      lapse_expired_shift_swap_days: { Args: never; Returns: number }
      next_transfer_reference: { Args: never; Returns: string }
      open_count_for_today: {
        Args: { p_branch: string; p_warehouse: string }
        Returns: string
      }
      post_sales_units: {
        Args: { p_acknowledge_existing?: boolean; p_posting: string }
        Returns: {
          lines_posted: number
          units_total: number
        }[]
      }
      publish_roster: {
        Args: { p_branch: string; p_month: string }
        Returns: {
          conflicts: number
          published: number
        }[]
      }
      receive_delivery: {
        Args: { p_delivery: string }
        Returns: {
          lines_received: number
          shortages_raised: number
          units_added: number
        }[]
      }
      receive_transfer: {
        Args: { p_transfer: string }
        Returns: {
          discrepancies_raised: number
          lines_received: number
          units_added: number
        }[]
      }
      reject_stock_adjustment: {
        Args: { p_adjustment: string; p_reason?: string }
        Returns: undefined
      }
      request_recount: { Args: { p_line: string }; Returns: undefined }
      resolve_shortage: {
        Args: { p_note?: string; p_shortage: string }
        Returns: undefined
      }
      roster_conflicts: {
        Args: { p_branch: string; p_month: string }
        Returns: {
          conflict_date: string
          detail: string
          kind: string
          staff_id: string
          staff_name: string
        }[]
      }
      save_daily_entry: {
        Args: {
          p_acknowledge_existing?: boolean
          p_bills?: Json
          p_branch: string
          p_date: string
          p_traffic?: Json
          p_units?: Json
        }
        Returns: {
          bills_recorded: number
          bills_total: number
          imported_bills: number
          moved_stock: boolean
          reconciles: boolean
          traffic_recorded: number
          units_posted: number
          units_total: number
        }[]
      }
      sees_all_branches: { Args: never; Returns: boolean }
      send_transfer: {
        Args: { p_transfer: string }
        Returns: {
          lines_sent: number
          terminal: boolean
          units_sent: number
        }[]
      }
      shift_swap_day_is_lapsed: {
        Args: { d: Database["public"]["Tables"]["shift_swap_days"]["Row"] }
        Returns: boolean
      }
      today_count_id: { Args: { p_warehouse: string }; Returns: string }
      units_entry_window: { Args: never; Returns: number }
      units_posted_on: {
        Args: { p_branch: string; p_date: string }
        Returns: {
          batches: number
          last_posted_at: string
          units: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

