import type { Config } from "tailwindcss";

/**
 * Mimetta palette, taken from docs/store-operations-demo.html.
 *
 * `brand` is kcp-portal's dark scale and is RETAINED DELIBERATELY. Thirteen
 * pages inherited from kcp-portal still use it — stock, sales, settings,
 * schedule and the rest — and they are not in the restyle scope. Deleting it
 * would not leave them looking dated; it would leave them unreadable, because
 * those pages pair `bg-brand-900` with `text-white`, and without the scale the
 * background disappears while the white text stays.
 *
 * So they keep working as dark panels inside a light shell. That looks
 * obviously unfinished, which is the honest signal: it marks exactly which
 * screens still need doing rather than hiding the gap behind a remap that
 * would make the text invisible.
 *
 * Remove `brand` once nothing references it.
 */
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── legacy: kcp-portal dark scale, still used by 13 unrestyled pages ──
        brand: {
          DEFAULT: "#1E1C1A",
          50: "#F5F4F3", 100: "#E8E6E3", 200: "#C8C4BF", 300: "#A8A29B",
          400: "#888077", 500: "#6B6460", 600: "#504C48", 700: "#383532",
          800: "#2A2826", 900: "#1E1C1A", 950: "#110F0E",
        },

        // ── Mimetta ──────────────────────────────────────────────────────
        cream:  "#FAF8F4",  // page
        panel:  "#F9F8F6",  // inset panels, stat tiles
        sand:   "#D8CBB0",  // the single border colour
        ink:    "#1A1A1A",  // body text
        brown:  "#1F3A2B",  // primary action
        accent: "#BD5A2E",  // terracotta
        sage:   "#9CAE8C",  // positive
        muted:  "#6B7280",
        subtle: "#9CA3AF",

        // Semantic tints, used for notes and status only — never as an accent.
        amber:  { 50: "#FAEEDA", 60: "#EF9F27", 70: "#854F0B" },
        danger: { 50: "#FCEBEB", 60: "#F09595", 70: "#A32D2D", 80: "#791F1F" },
        good:   { 50: "#EAF3DE", 70: "#3B6D11" },
        info:   { 50: "#EEEDFE", 60: "#AFA9EC", 65: "#534AB7", 70: "#3C3489" },
      },
      fontFamily: {
        sans: ["'DM Sans'", "'Noto Sans Thai'", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontSize: {
        base: ["14px", "1.5"],
      },
      borderRadius: {
        card: "10px",
      },
    },
  },
  plugins: [],
};
export default config;
