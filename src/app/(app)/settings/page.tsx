import SettingsBody from "./SettingsBody"

/**
 * The settings page, all tabs.
 *
 * The body lives in `SettingsBody.tsx` rather than here because a Next.js
 * page file may export ONLY the route — adding a named export for the
 * four single-tab routes failed the build with "Property 'SettingsBody' is
 * incompatible with index signature". The component is shared, not copied:
 * five copies of four fetch patterns is how two screens drift, which the
 * navigation already demonstrated expensively.
 */
export default function SettingsPage() {
  return <SettingsBody />
}
