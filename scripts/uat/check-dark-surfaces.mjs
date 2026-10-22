#!/usr/bin/env node
/**
 * No surface is left on the pre-restyle dark palette.
 *
 *   npm run check:dark-surfaces
 *
 * The restyle went screen by screen and counted classes PER PAGE. A modal
 * belongs to a COMPONENT, so `src/components/retail/Drawer.tsx` was never in
 * the count — and it stayed `bg-brand-900` with white text, inside a cream
 * app, for four screens at once: Settings, Calendar, Training and Leave.
 *
 * A phone test found it as white-on-dark in the Request Leave form. "Every
 * screen is restyled" had been true and useless, because the thing that was
 * wrong was not a screen.
 *
 * So this looks at every .tsx under src/, not at a list of pages.
 *
 * ── WHAT COUNTS AS DARK ───────────────────────────────────────────────────
 *
 * The old palette's surface tokens. `text-white` is NOT on the list by
 * itself: it is correct on a brown pill, a badge or an avatar, and flagging
 * it would produce noise that teaches people to ignore this check. What is
 * flagged is a dark BACKGROUND, which is what makes a surface the wrong one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** Dark surface tokens from the palette the app moved away from. */
const DARK_BG = /\bbg-brand-(?:700|800|900)\b|\bbg-(?:gray|slate|zinc|neutral)-(?:800|900)\b|\bbg-black\b(?!\/)/
/** Borders that only make sense on a dark surface. */
const DARK_BORDER = /\bborder-brand-(?:700|800|900)\b/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(name)) out.push(p)
  }
  return out
}

const files = walk("src")
const hits = []

for (const file of files) {
  const src = readFileSync(file, "utf8")
  src.split("\n").forEach((line, i) => {
    // Comments explain the fix and must not trip it — the Drawer's own
    // header says `bg-brand-900` while describing why it no longer does.
    const code = line.replace(/\/\/.*$/, "").replace(/\*.*$/, "")
    if (DARK_BG.test(code) || DARK_BORDER.test(code)) {
      hits.push({ file, line: i + 1, text: line.trim().slice(0, 76) })
    }
  })
}

console.log(`Checked ${files.length} component(s) and screen(s) for dark surfaces.\n`)

for (const h of hits) {
  console.log(`  DARK  ${h.file}:${h.line}`)
  console.log(`        ${h.text}`)
}

if (!hits.length) {
  console.log(`OK: no dark surface survives in the cream app.`)
  console.log(`    Every .tsx under src/, not a list of pages — a modal lives`)
  console.log(`    in a component, which is how the last one hid.`)
  process.exit(0)
}

console.log(`
The app is cream. Use the design tokens:

    surface     bg-cream / bg-white / bg-panel
    border      border-sand
    text        text-ink / text-muted / text-subtle

\`text-white\` on a brown pill or badge is fine and is not flagged — a dark
BACKGROUND is what makes a surface the wrong one.`)
process.exit(1)
