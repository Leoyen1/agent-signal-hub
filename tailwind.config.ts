import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
      colors: {
        ink: "#17211c",
        field: "#f4f7f1",
        moss: "#4f6f52",
        signal: "#d65745",
        steel: "#536878",
        amber: "#c2842d",
      },
      boxShadow: {
        line: "inset 0 0 0 1px rgba(23,33,28,0.1)",
      },
    },
  },
  plugins: [],
};

export default config;
