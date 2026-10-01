import type { Config } from "tailwindcss";

// Design tokens. Contrast-checked on `surface` (#12161f): text 15:1, text2 8:1, text3 5:1 —
// every text tier passes WCAG AA at small sizes (text3 used to be ~3.6:1).
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0e14",
        surface: "#12161f",
        surface2: "#1a2029",
        surface3: "#222936",
        border: "#262e3b",
        border2: "#333c4c",
        text: "#e7eaf0",
        text2: "#adb6c6",
        text3: "#8790a1",
        accent: "#4f7cff",
        accent2: "#7da0ff",
        green: "#3ccb91",
        red: "#f06478",
        orange: "#f2994a",
        yellow: "#e6b93e",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      maxWidth: {
        // One container for header, nav and page content, so every edge lines up.
        shell: "84rem",
      },
      boxShadow: {
        card: "0 1px 0 0 rgb(255 255 255 / 0.02) inset, 0 1px 2px 0 rgb(0 0 0 / 0.3)",
        pop: "0 12px 32px -8px rgb(0 0 0 / 0.6)",
      },
    },
  },
  plugins: [],
};
export default config;
