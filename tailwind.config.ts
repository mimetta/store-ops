import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#1E1C1A",
          50: "#F5F4F3",
          100: "#E8E6E3",
          200: "#C8C4BF",
          300: "#A8A29B",
          400: "#888077",
          500: "#6B6460",
          600: "#504C48",
          700: "#383532",
          800: "#2A2826",
          900: "#1E1C1A",
          950: "#110F0E",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
