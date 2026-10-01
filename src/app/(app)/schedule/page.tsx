import { redirect } from "next/navigation"

/**
 * The roster moved to /shifts.
 *
 * Redirected rather than deleted: the link is in people's history and a 404
 * teaches nothing.
 */
export default function ScheduleRedirect() {
  redirect("/shifts")
}
