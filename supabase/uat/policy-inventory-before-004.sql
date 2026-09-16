-- Policy inventory captured from UAT immediately BEFORE 004-rbac-rls.sql ran.
-- UAT was loaded from supabase/uat/prod-schema.sql, so this is also the
-- production policy set as of that dump (2026-09-16).
--
-- This is the restore path for 004. 004 drops pre-existing policies; running
-- these statements recreates them exactly as they were.
--
-- To restore: drop the policies 004 created first, then run this file.
-- Leaving both sets in place would OR them together and reinstate the
-- permissive USING (true) rules that 004 exists to remove.
--
-- Policies: 50
create policy "Authenticated can insert logs" on public.activity_logs for insert to authenticated with check (true);
create policy "Authenticated can view logs" on public.activity_logs for select to authenticated using (true);
create policy "Admins and managers can post announcements" on public.announcements for insert to authenticated with check ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated users can view announcements" on public.announcements for select to authenticated using (true);
create policy "Admins/managers can manage branches" on public.branches for all to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text, 'superadmin'::text]))) with check ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text, 'superadmin'::text])));
create policy "Authenticated can view branches" on public.branches for select to authenticated using (true);
create policy "Admins/managers can manage calendar_events" on public.calendar_events for all to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated can view calendar_events" on public.calendar_events for select to authenticated using (true);
create policy "Auth can manage settings" on public.company_settings for all to authenticated using (true);
create policy "Auth can view settings" on public.company_settings for select to authenticated using (true);
create policy "Authenticated users can manage daily_sales_summary" on public.daily_sales_summary for all to authenticated using (true) with check (true);
create policy "Auth can manage departments" on public.departments for all to authenticated using (true);
create policy "Auth can view departments" on public.departments for select to authenticated using (true);
create policy "Authenticated users can manage fg_stock_withdrawals" on public.fg_stock_withdrawals for all to authenticated using (true) with check (true);
create policy "Admins/managers can update leave_requests" on public.leave_requests for update to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated can view leave requests" on public.leave_requests for select to authenticated using (true);
create policy "Managers can update leave status" on public.leave_requests for update to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Staff can insert leave_requests" on public.leave_requests for insert to authenticated with check ((staff_id = auth.uid()));
create policy "Staff can insert own leave" on public.leave_requests for insert to authenticated with check ((staff_id = auth.uid()));
create policy "Staff can view own leave_requests" on public.leave_requests for select to authenticated using (((staff_id = auth.uid()) OR (( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text]))));
create policy "Admins and managers can post news" on public.news for insert to authenticated with check ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated users can view news" on public.news for select to authenticated using (true);
create policy "Authenticated users can manage pos_money_records" on public.pos_money_records for all to authenticated using (true) with check (true);
create policy "Admins/managers can manage products" on public.products for all to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated can view products" on public.products for select to authenticated using (true);
create policy "Admins can insert profiles" on public.profiles for insert to authenticated with check ((( SELECT profiles_1.portal_role
   FROM profiles profiles_1
  WHERE (profiles_1.id = auth.uid())) = 'admin'::text));
create policy "Admins can update any profile" on public.profiles for update to authenticated using ((EXISTS ( SELECT 1
   FROM profiles profiles_1
  WHERE ((profiles_1.id = auth.uid()) AND (profiles_1.portal_role = ANY (ARRAY['admin'::text, 'superadmin'::text])))))) with check ((EXISTS ( SELECT 1
   FROM profiles profiles_1
  WHERE ((profiles_1.id = auth.uid()) AND (profiles_1.portal_role = ANY (ARRAY['admin'::text, 'superadmin'::text]))))));
create policy "Anyone authenticated can view profiles" on public.profiles for select to authenticated using (true);
create policy "Users can update their own profile" on public.profiles for update to authenticated using ((auth.uid() = id));
create policy "Auth can manage roles" on public.roles for all to authenticated using (true);
create policy "Auth can view roles" on public.roles for select to authenticated using (true);
create policy "Authenticated users can manage sales_records" on public.sales_records for all to authenticated using (true) with check (true);
create policy "Authenticated users can view services" on public.services for select to authenticated using (true);
create policy "Authenticated can submit shop_traffic" on public.shop_traffic for insert to authenticated with check ((submitted_by = auth.uid()));
create policy "Authenticated can upsert shop_traffic" on public.shop_traffic for update to authenticated using ((submitted_by = auth.uid()));
create policy "Authenticated can view shop_traffic" on public.shop_traffic for select to authenticated using (true);
create policy "Admins/managers can manage stock_levels" on public.stock_levels for all to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated can view stock_levels" on public.stock_levels for select to authenticated using (true);
create policy "Admins/managers can insert stock_movements" on public.stock_movements for insert to authenticated with check ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated can view stock_movements" on public.stock_movements for select to authenticated using (true);
create policy "Admins/managers can manage suppliers" on public.suppliers for all to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text]))) with check ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated can view suppliers" on public.suppliers for select to authenticated using (true);
create policy "Admins/managers can manage training_progress" on public.training_progress for all to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Staff can view own training_progress" on public.training_progress for select to authenticated using (((staff_id = auth.uid()) OR (( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text]))));
create policy "Admins/managers can manage training_sessions" on public.training_sessions for all to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated can view training_sessions" on public.training_sessions for select to authenticated using (true);
create policy "Auth can manage user_departments" on public.user_departments for all to authenticated using (true);
create policy "Auth can view user_departments" on public.user_departments for select to authenticated using (true);
create policy "Admins/managers can manage work_schedules" on public.work_schedules for all to authenticated using ((( SELECT profiles.portal_role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'manager'::text])));
create policy "Authenticated can view work_schedules" on public.work_schedules for select to authenticated using (true);
