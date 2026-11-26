import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./client/index.html", "./client/kiosk.html", "./client/me.html", "./client/src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        "2xl": "1.125rem", /* 18px — dialogs, hero cards */
        xl: ".875rem", /* 14px — cards */
        lg: ".75rem", /* 12px */
        md: ".625rem", /* 10px — buttons, inputs */
        sm: ".375rem", /* 6px */
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(0 0 0 / 0.03)",
        float: "0 10px 30px -10px rgb(0 0 0 / 0.18), 0 2px 6px -2px rgb(0 0 0 / 0.06)",
        pop: "0 24px 64px -16px rgb(0 0 0 / 0.28), 0 4px 12px -4px rgb(0 0 0 / 0.08)",
        segment: "0 1px 2px 0 rgb(0 0 0 / 0.10), 0 0 0 0.5px rgb(0 0 0 / 0.04)",
      },
      transitionDuration: { DEFAULT: "180ms" },
      transitionTimingFunction: { DEFAULT: "cubic-bezier(0.2, 0, 0, 1)" },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        "display": ["1.75rem", { lineHeight: "2.125rem", letterSpacing: "-0.022em", fontWeight: "700" }],
      },
      colors: {
        // Flat / base colors (regular buttons)
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
          border: "hsl(var(--card-border) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
          border: "hsl(var(--popover-border) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
          border: "var(--primary-border)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
          border: "var(--secondary-border)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
          border: "var(--muted-border)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
          border: "var(--accent-border)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
          border: "var(--destructive-border)",
        },
        ring: "hsl(var(--ring) / <alpha-value>)",
        chart: {
          "1": "hsl(var(--chart-1) / <alpha-value>)",
          "2": "hsl(var(--chart-2) / <alpha-value>)",
          "3": "hsl(var(--chart-3) / <alpha-value>)",
          "4": "hsl(var(--chart-4) / <alpha-value>)",
          "5": "hsl(var(--chart-5) / <alpha-value>)",
        },
        sidebar: {
          ring: "hsl(var(--sidebar-ring) / <alpha-value>)",
          DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-foreground) / <alpha-value>)",
          border: "hsl(var(--sidebar-border) / <alpha-value>)",
        },
        "sidebar-primary": {
          DEFAULT: "hsl(var(--sidebar-primary) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-primary-foreground) / <alpha-value>)",
          border: "var(--sidebar-primary-border)",
        },
        "sidebar-accent": {
          DEFAULT: "hsl(var(--sidebar-accent) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-accent-foreground) / <alpha-value>)",
          border: "var(--sidebar-accent-border)"
        },
        segment: "hsl(var(--segment) / <alpha-value>)",
        brand: {
          ink: "hsl(var(--brand-ink) / <alpha-value>)",
          rice: "hsl(var(--brand-rice) / <alpha-value>)",
          tonal: "hsl(var(--brand-tonal) / <alpha-value>)",
          muted: "hsl(var(--brand-muted) / <alpha-value>)",
        },
        success: { DEFAULT: "hsl(var(--success) / <alpha-value>)", soft: "hsl(var(--success-soft) / <alpha-value>)" },
        warning: { DEFAULT: "hsl(var(--warning) / <alpha-value>)", soft: "hsl(var(--warning-soft) / <alpha-value>)" },
        danger: { DEFAULT: "hsl(var(--danger) / <alpha-value>)", soft: "hsl(var(--danger-soft) / <alpha-value>)" },
        neutral: { DEFAULT: "hsl(var(--neutral) / <alpha-value>)", soft: "hsl(var(--neutral-soft) / <alpha-value>)" },
        info: { DEFAULT: "hsl(var(--info) / <alpha-value>)", soft: "hsl(var(--info-soft) / <alpha-value>)" },
        status: {
          online: "rgb(34 197 94)",
          away: "rgb(245 158 11)",
          busy: "rgb(239 68 68)",
          offline: "rgb(156 163 175)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
        display: ["var(--font-display)"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
} satisfies Config;
