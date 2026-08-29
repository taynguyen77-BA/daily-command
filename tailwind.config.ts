import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0e14",
        surface: "#12161f",
        surface2: "#1a2029",
        border: "#232a36",
        text: "#e7eaf0",
        text2: "#9aa4b5",
        text3: "#6b7484",
        accent: "#4f7cff",
        accent2: "#749bff",
        green: "#33c48a",
        red: "#ef5a6f",
        orange: "#f2994a",
        yellow: "#e6b93e",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
