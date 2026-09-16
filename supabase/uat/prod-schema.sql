


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."activity_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "user_name" "text",
    "action" "text" NOT NULL,
    "module" "text" NOT NULL,
    "record_id" "text",
    "record_label" "text",
    "old_value" "jsonb",
    "new_value" "jsonb",
    "branch_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."activity_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."announcements" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "category" "text" DEFAULT 'general'::"text",
    "posted_by" "uuid",
    "is_pinned" boolean DEFAULT false,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "announcements_category_check" CHECK (("category" = ANY (ARRAY['general'::"text", 'hr'::"text", 'operations'::"text", 'urgent'::"text", 'event'::"text"])))
);


ALTER TABLE "public"."announcements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."branches" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "location" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "active" boolean DEFAULT true
);


ALTER TABLE "public"."branches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "event_type" "text",
    "branch_id" "uuid",
    "start_date" "date" NOT NULL,
    "end_date" "date",
    "start_time" time without time zone,
    "end_time" time without time zone,
    "description" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "calendar_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['ma_visit'::"text", 'appointment'::"text", 'internal'::"text", 'training'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."calendar_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chapters" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" DEFAULT '#1E1C1A'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."chapters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."company_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "value" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."company_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_sales_summary" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid",
    "sale_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "total_amount" integer DEFAULT 0 NOT NULL,
    "recorded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "pay_cash" integer DEFAULT 0,
    "pay_card" integer DEFAULT 0,
    "pay_transfer" integer DEFAULT 0,
    "pay_alipay" integer DEFAULT 0,
    "pay_wechat" integer DEFAULT 0,
    "pay_other" integer DEFAULT 0
);


ALTER TABLE "public"."daily_sales_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."departments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fg_stock_withdrawals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid",
    "product_id" "uuid",
    "requested_by" "uuid",
    "approved_by" "uuid",
    "lot_number" "text" NOT NULL,
    "withdraw_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'pending'::"text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "fg_stock_withdrawals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."fg_stock_withdrawals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leave_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "staff_id" "uuid",
    "leave_type" "text" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "reason" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "total_days" integer,
    "branch_id" "uuid",
    CONSTRAINT "leave_requests_leave_type_check" CHECK (("leave_type" = ANY (ARRAY['annual'::"text", 'sick'::"text", 'personal'::"text", 'other'::"text"]))),
    CONSTRAINT "leave_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."leave_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."news" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "tag" "text",
    "cover_url" "text",
    "posted_by" "uuid",
    "published_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."news" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pos_money_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid",
    "recorded_by" "uuid",
    "record_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "denom_1" integer DEFAULT 0,
    "denom_5" integer DEFAULT 0,
    "denom_10" integer DEFAULT 0,
    "denom_20" integer DEFAULT 0,
    "denom_50" integer DEFAULT 0,
    "denom_100" integer DEFAULT 0,
    "denom_500" integer DEFAULT 0,
    "denom_1000" integer DEFAULT 0,
    "total_amount" integer GENERATED ALWAYS AS ((((((((("denom_1" * 1) + ("denom_5" * 5)) + ("denom_10" * 10)) + ("denom_20" * 20)) + ("denom_50" * 50)) + ("denom_100" * 100)) + ("denom_500" * 500)) + ("denom_1000" * 1000))) STORED,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "pay_cash" integer DEFAULT 0,
    "pay_card" integer DEFAULT 0,
    "pay_transfer" integer DEFAULT 0,
    "pay_alipay" integer DEFAULT 0,
    "pay_wechat" integer DEFAULT 0,
    "pay_other" integer DEFAULT 0
);


ALTER TABLE "public"."pos_money_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sku" "text" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text",
    "unit" "text" DEFAULT 'piece'::"text",
    "type" "text",
    "reorder_threshold" integer DEFAULT 20,
    "cost_price" numeric,
    "selling_price" numeric,
    "supplier" "text",
    "location" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "products_type_check" CHECK (("type" = ANY (ARRAY['fg'::"text", 'consumable'::"text"])))
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "nickname" "text",
    "chapter" "text",
    "role" "text",
    "branch_id" "uuid",
    "employment_type" "text",
    "start_date" "date",
    "line_manager_id" "uuid",
    "portal_role" "text" DEFAULT 'staff'::"text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "profiles_employment_type_check" CHECK (("employment_type" = ANY (ARRAY['full_time'::"text", 'part_time'::"text", 'contract'::"text", 'intern'::"text"]))),
    CONSTRAINT "profiles_portal_role_check" CHECK (("portal_role" = ANY (ARRAY['superadmin'::"text", 'admin'::"text", 'manager'::"text", 'staff'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_global" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid",
    "product_id" "uuid",
    "recorded_by" "uuid",
    "units_sold" integer DEFAULT 0 NOT NULL,
    "sale_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sales_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."services" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "url" "text",
    "status" "text" DEFAULT 'active'::"text",
    "icon" "text",
    "category" "text",
    "sort_order" integer DEFAULT 0,
    "open_in" "text" DEFAULT 'iframe'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "services_open_in_check" CHECK (("open_in" = ANY (ARRAY['iframe'::"text", 'link'::"text", 'native'::"text"]))),
    CONSTRAINT "services_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'building'::"text", 'planned'::"text", 'maintenance'::"text"])))
);


ALTER TABLE "public"."services" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shop_traffic" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid",
    "date" "date" NOT NULL,
    "thai_count" integer DEFAULT 0,
    "foreigner_count" integer DEFAULT 0,
    "notes" "text",
    "submitted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."shop_traffic" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_levels" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid",
    "branch_id" "uuid",
    "quantity" integer DEFAULT 0,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "minimum_override" integer
);


ALTER TABLE "public"."stock_levels" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid",
    "branch_id" "uuid",
    "movement_type" "text",
    "quantity" integer NOT NULL,
    "reference" "text",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "stock_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['in'::"text", 'out'::"text", 'adjustment'::"text"])))
);


ALTER TABLE "public"."stock_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "contact" "text",
    "email" "text",
    "phone" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."training_progress" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid",
    "staff_id" "uuid",
    "assigned_by" "uuid",
    "status" "text" DEFAULT 'not_started'::"text",
    "completed_at" timestamp with time zone,
    "notes" "text",
    CONSTRAINT "training_progress_status_check" CHECK (("status" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."training_progress" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."training_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "required_for" "text" DEFAULT 'all'::"text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."training_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "department_id" "uuid",
    "role_in_department" "text" DEFAULT 'staff'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_departments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "staff_id" "uuid",
    "branch_id" "uuid",
    "date" "date" NOT NULL,
    "shift" "text",
    "notes" "text",
    "created_by" "uuid",
    CONSTRAINT "work_schedules_shift_check" CHECK (("shift" = ANY (ARRAY['am'::"text", 'pm'::"text", 'full'::"text", 'off'::"text", 'leave'::"text"])))
);


ALTER TABLE "public"."work_schedules" OWNER TO "postgres";


ALTER TABLE ONLY "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."branches"
    ADD CONSTRAINT "branches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chapters"
    ADD CONSTRAINT "chapters_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."chapters"
    ADD CONSTRAINT "chapters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_settings"
    ADD CONSTRAINT "company_settings_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."company_settings"
    ADD CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_sales_summary"
    ADD CONSTRAINT "daily_sales_summary_branch_id_sale_date_key" UNIQUE ("branch_id", "sale_date");



ALTER TABLE ONLY "public"."daily_sales_summary"
    ADD CONSTRAINT "daily_sales_summary_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fg_stock_withdrawals"
    ADD CONSTRAINT "fg_stock_withdrawals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."news"
    ADD CONSTRAINT "news_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pos_money_records"
    ADD CONSTRAINT "pos_money_records_branch_id_record_date_key" UNIQUE ("branch_id", "record_date");



ALTER TABLE ONLY "public"."pos_money_records"
    ADD CONSTRAINT "pos_money_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_sku_key" UNIQUE ("sku");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_name_isglobal_key" UNIQUE ("name", "is_global");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_branch_id_product_id_sale_date_key" UNIQUE ("branch_id", "product_id", "sale_date");



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."services"
    ADD CONSTRAINT "services_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shop_traffic"
    ADD CONSTRAINT "shop_traffic_branch_id_date_key" UNIQUE ("branch_id", "date");



ALTER TABLE ONLY "public"."shop_traffic"
    ADD CONSTRAINT "shop_traffic_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_levels"
    ADD CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_levels"
    ADD CONSTRAINT "stock_levels_product_id_branch_id_key" UNIQUE ("product_id", "branch_id");



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_progress"
    ADD CONSTRAINT "training_progress_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_progress"
    ADD CONSTRAINT "training_progress_session_id_staff_id_key" UNIQUE ("session_id", "staff_id");



ALTER TABLE ONLY "public"."training_sessions"
    ADD CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_departments"
    ADD CONSTRAINT "user_departments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_departments"
    ADD CONSTRAINT "user_departments_user_id_department_id_key" UNIQUE ("user_id", "department_id");



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_staff_id_date_key" UNIQUE ("staff_id", "date");



ALTER TABLE ONLY "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");



ALTER TABLE ONLY "public"."activity_logs"
    ADD CONSTRAINT "activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."announcements"
    ADD CONSTRAINT "announcements_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");



ALTER TABLE ONLY "public"."calendar_events"
    ADD CONSTRAINT "calendar_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."daily_sales_summary"
    ADD CONSTRAINT "daily_sales_summary_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_sales_summary"
    ADD CONSTRAINT "daily_sales_summary_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."fg_stock_withdrawals"
    ADD CONSTRAINT "fg_stock_withdrawals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."fg_stock_withdrawals"
    ADD CONSTRAINT "fg_stock_withdrawals_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");



ALTER TABLE ONLY "public"."fg_stock_withdrawals"
    ADD CONSTRAINT "fg_stock_withdrawals_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."fg_stock_withdrawals"
    ADD CONSTRAINT "fg_stock_withdrawals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");



ALTER TABLE ONLY "public"."leave_requests"
    ADD CONSTRAINT "leave_requests_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."news"
    ADD CONSTRAINT "news_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pos_money_records"
    ADD CONSTRAINT "pos_money_records_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pos_money_records"
    ADD CONSTRAINT "pos_money_records_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_chapter_fkey" FOREIGN KEY ("chapter") REFERENCES "public"."chapters"("name");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_line_manager_id_fkey" FOREIGN KEY ("line_manager_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sales_records"
    ADD CONSTRAINT "sales_records_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."shop_traffic"
    ADD CONSTRAINT "shop_traffic_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shop_traffic"
    ADD CONSTRAINT "shop_traffic_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."stock_levels"
    ADD CONSTRAINT "stock_levels_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_levels"
    ADD CONSTRAINT "stock_levels_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."training_progress"
    ADD CONSTRAINT "training_progress_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."training_progress"
    ADD CONSTRAINT "training_progress_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."training_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."training_progress"
    ADD CONSTRAINT "training_progress_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."training_sessions"
    ADD CONSTRAINT "training_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."user_departments"
    ADD CONSTRAINT "user_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_departments"
    ADD CONSTRAINT "user_departments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."work_schedules"
    ADD CONSTRAINT "work_schedules_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



CREATE POLICY "Admins and managers can post announcements" ON "public"."announcements" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins and managers can post news" ON "public"."news" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins can insert profiles" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "profiles_1"."portal_role"
   FROM "public"."profiles" "profiles_1"
  WHERE ("profiles_1"."id" = "auth"."uid"())) = 'admin'::"text"));



CREATE POLICY "Admins can update any profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "profiles_1"
  WHERE (("profiles_1"."id" = "auth"."uid"()) AND ("profiles_1"."portal_role" = ANY (ARRAY['admin'::"text", 'superadmin'::"text"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "profiles_1"
  WHERE (("profiles_1"."id" = "auth"."uid"()) AND ("profiles_1"."portal_role" = ANY (ARRAY['admin'::"text", 'superadmin'::"text"]))))));



CREATE POLICY "Admins/managers can insert stock_movements" ON "public"."stock_movements" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins/managers can manage branches" ON "public"."branches" TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text", 'superadmin'::"text"]))) WITH CHECK ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text", 'superadmin'::"text"])));



CREATE POLICY "Admins/managers can manage calendar_events" ON "public"."calendar_events" TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins/managers can manage products" ON "public"."products" TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins/managers can manage stock_levels" ON "public"."stock_levels" TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins/managers can manage suppliers" ON "public"."suppliers" TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"]))) WITH CHECK ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins/managers can manage training_progress" ON "public"."training_progress" TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins/managers can manage training_sessions" ON "public"."training_sessions" TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins/managers can manage work_schedules" ON "public"."work_schedules" TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Admins/managers can update leave_requests" ON "public"."leave_requests" FOR UPDATE TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Anyone authenticated can view profiles" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Auth can manage departments" ON "public"."departments" TO "authenticated" USING (true);



CREATE POLICY "Auth can manage roles" ON "public"."roles" TO "authenticated" USING (true);



CREATE POLICY "Auth can manage settings" ON "public"."company_settings" TO "authenticated" USING (true);



CREATE POLICY "Auth can manage user_departments" ON "public"."user_departments" TO "authenticated" USING (true);



CREATE POLICY "Auth can view departments" ON "public"."departments" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Auth can view roles" ON "public"."roles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Auth can view settings" ON "public"."company_settings" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Auth can view user_departments" ON "public"."user_departments" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can insert logs" ON "public"."activity_logs" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Authenticated can submit shop_traffic" ON "public"."shop_traffic" FOR INSERT TO "authenticated" WITH CHECK (("submitted_by" = "auth"."uid"()));



CREATE POLICY "Authenticated can upsert shop_traffic" ON "public"."shop_traffic" FOR UPDATE TO "authenticated" USING (("submitted_by" = "auth"."uid"()));



CREATE POLICY "Authenticated can view branches" ON "public"."branches" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view calendar_events" ON "public"."calendar_events" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view leave requests" ON "public"."leave_requests" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view logs" ON "public"."activity_logs" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view products" ON "public"."products" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view shop_traffic" ON "public"."shop_traffic" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view stock_levels" ON "public"."stock_levels" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view stock_movements" ON "public"."stock_movements" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view suppliers" ON "public"."suppliers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view training_sessions" ON "public"."training_sessions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated can view work_schedules" ON "public"."work_schedules" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can manage daily_sales_summary" ON "public"."daily_sales_summary" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can manage fg_stock_withdrawals" ON "public"."fg_stock_withdrawals" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can manage pos_money_records" ON "public"."pos_money_records" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can manage sales_records" ON "public"."sales_records" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users can view announcements" ON "public"."announcements" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can view news" ON "public"."news" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can view services" ON "public"."services" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Managers can update leave status" ON "public"."leave_requests" FOR UPDATE TO "authenticated" USING ((( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"])));



CREATE POLICY "Staff can insert leave_requests" ON "public"."leave_requests" FOR INSERT TO "authenticated" WITH CHECK (("staff_id" = "auth"."uid"()));



CREATE POLICY "Staff can insert own leave" ON "public"."leave_requests" FOR INSERT TO "authenticated" WITH CHECK (("staff_id" = "auth"."uid"()));



CREATE POLICY "Staff can view own leave_requests" ON "public"."leave_requests" FOR SELECT TO "authenticated" USING ((("staff_id" = "auth"."uid"()) OR (( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"]))));



CREATE POLICY "Staff can view own training_progress" ON "public"."training_progress" FOR SELECT TO "authenticated" USING ((("staff_id" = "auth"."uid"()) OR (( SELECT "profiles"."portal_role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'manager'::"text"]))));



CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."activity_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."announcements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."branches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chapters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."company_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_sales_summary" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fg_stock_withdrawals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leave_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."news" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pos_money_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."services" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shop_traffic" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_levels" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."training_progress" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."training_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_departments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."work_schedules" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";


















GRANT ALL ON TABLE "public"."activity_logs" TO "anon";
GRANT ALL ON TABLE "public"."activity_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_logs" TO "service_role";



GRANT ALL ON TABLE "public"."announcements" TO "anon";
GRANT ALL ON TABLE "public"."announcements" TO "authenticated";
GRANT ALL ON TABLE "public"."announcements" TO "service_role";



GRANT ALL ON TABLE "public"."branches" TO "anon";
GRANT ALL ON TABLE "public"."branches" TO "authenticated";
GRANT ALL ON TABLE "public"."branches" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_events" TO "service_role";



GRANT ALL ON TABLE "public"."chapters" TO "anon";
GRANT ALL ON TABLE "public"."chapters" TO "authenticated";
GRANT ALL ON TABLE "public"."chapters" TO "service_role";



GRANT ALL ON TABLE "public"."company_settings" TO "anon";
GRANT ALL ON TABLE "public"."company_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."company_settings" TO "service_role";



GRANT ALL ON TABLE "public"."daily_sales_summary" TO "anon";
GRANT ALL ON TABLE "public"."daily_sales_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_sales_summary" TO "service_role";



GRANT ALL ON TABLE "public"."departments" TO "anon";
GRANT ALL ON TABLE "public"."departments" TO "authenticated";
GRANT ALL ON TABLE "public"."departments" TO "service_role";



GRANT ALL ON TABLE "public"."fg_stock_withdrawals" TO "anon";
GRANT ALL ON TABLE "public"."fg_stock_withdrawals" TO "authenticated";
GRANT ALL ON TABLE "public"."fg_stock_withdrawals" TO "service_role";



GRANT ALL ON TABLE "public"."leave_requests" TO "anon";
GRANT ALL ON TABLE "public"."leave_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."leave_requests" TO "service_role";



GRANT ALL ON TABLE "public"."news" TO "anon";
GRANT ALL ON TABLE "public"."news" TO "authenticated";
GRANT ALL ON TABLE "public"."news" TO "service_role";



GRANT ALL ON TABLE "public"."pos_money_records" TO "anon";
GRANT ALL ON TABLE "public"."pos_money_records" TO "authenticated";
GRANT ALL ON TABLE "public"."pos_money_records" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "anon";
GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON TABLE "public"."sales_records" TO "anon";
GRANT ALL ON TABLE "public"."sales_records" TO "authenticated";
GRANT ALL ON TABLE "public"."sales_records" TO "service_role";



GRANT ALL ON TABLE "public"."services" TO "anon";
GRANT ALL ON TABLE "public"."services" TO "authenticated";
GRANT ALL ON TABLE "public"."services" TO "service_role";



GRANT ALL ON TABLE "public"."shop_traffic" TO "anon";
GRANT ALL ON TABLE "public"."shop_traffic" TO "authenticated";
GRANT ALL ON TABLE "public"."shop_traffic" TO "service_role";



GRANT ALL ON TABLE "public"."stock_levels" TO "anon";
GRANT ALL ON TABLE "public"."stock_levels" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_levels" TO "service_role";



GRANT ALL ON TABLE "public"."stock_movements" TO "anon";
GRANT ALL ON TABLE "public"."stock_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_movements" TO "service_role";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."suppliers" TO "service_role";



GRANT ALL ON TABLE "public"."training_progress" TO "anon";
GRANT ALL ON TABLE "public"."training_progress" TO "authenticated";
GRANT ALL ON TABLE "public"."training_progress" TO "service_role";



GRANT ALL ON TABLE "public"."training_sessions" TO "anon";
GRANT ALL ON TABLE "public"."training_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."training_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."user_departments" TO "anon";
GRANT ALL ON TABLE "public"."user_departments" TO "authenticated";
GRANT ALL ON TABLE "public"."user_departments" TO "service_role";



GRANT ALL ON TABLE "public"."work_schedules" TO "anon";
GRANT ALL ON TABLE "public"."work_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."work_schedules" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































