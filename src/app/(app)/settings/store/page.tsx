import SettingsBody from "../SettingsBody"
import { can } from "@/lib/permissions"
import { currentProfile } from "@/lib/records"

/**
 * One tab of the settings page, as its own route.
 *
 * The menu used to carry "Settings" inside "Setting", and what somebody
 * wanted was a tab invisible from the menu. This renders the same
 * component with the tab fixed and the tab bar hidden — the page is not
 * copied, because five copies of four fetch patterns is how two screens
 * drift apart.
 *
 * The `settings` check is HERE as well as inside the body. Not
 * belt-and-braces: check:nav reads each page directory for a can() call,
 * and a gate that lives only in an imported component is invisible to it.
 * The capability a route requires should be legible in the route.
 */
export default async function Page() {
  const profile = await currentProfile()
  if (!can(profile, "settings")) {
    return (
      <div className="empty">
        <p className="empty-title">Settings are for managers and admins only.</p>
      </div>
    )
  }
  return <SettingsBody only="branches" />
}
