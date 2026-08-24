/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Auto 1 Oil brand: gold/amber primary, red as secondary accent.
        // Gold buttons feel warmer than red, which can read as "warning."
        brand: {
          50:  '#FEF3C7',  // very light gold tint
          100: '#FDE68A',
          200: '#FCD34D',
          300: '#FBBF24',
          400: '#F8A80A',
          500: '#F59E0B',  // mid amber
          600: '#D97706',  // gold CTA (used app-wide, e.g. the Add buttons)
          700: '#B45309',  // primary CTA gold (good contrast w/ white text)
          800: '#92400E',
          900: '#78350F',  // dark amber — header backgrounds
        },
        accent: {
          50:  '#FEF2F2',  // light red tint
          300: '#FCA5A5',  // light red text
          400: '#EF4444',
          500: '#DC2626',  // red highlight (stripes, danger chips)
          700: '#B91C1C',
        },
      },
    },
  },
  plugins: [],
};
