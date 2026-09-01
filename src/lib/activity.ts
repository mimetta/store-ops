import { createClient } from '@/lib/supabase/client'

export async function logActivity({
  action,
  module,
  recordId,
  recordLabel,
  oldValue,
  newValue,
  branchId,
}: {
  action: string
  module: string
  recordId?: string
  recordLabel?: string
  oldValue?: Record<string, unknown>
  newValue?: Record<string, unknown>
  branchId?: string
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .single()
  await supabase.from('activity_logs').insert({
    user_id: user.id,
    user_name: profile?.full_name || user.email,
    action,
    module,
    record_id: recordId,
    record_label: recordLabel,
    old_value: oldValue,
    new_value: newValue,
    branch_id: branchId,
  })
}
