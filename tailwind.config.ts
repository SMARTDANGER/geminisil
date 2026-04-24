import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0b",
        panel: "#121215",
        border: "#1f1f24",
        accent: "#8b5cf6",
      },
    },
  },
  plugins: [],
};
export default config;
