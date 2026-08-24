/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Stallion: deep steel blue primary (headers, buttons), warm gold as
        // the accent stripe and highlight. Swap these for the real brand
        // palette — every screen reads its colors from here.
        brand: {
          50:  '#E8F0F6',  // very light blue tint
          100: '#C7DBE9',
          200: '#9CBFD6',
          300: '#6F9FC0',
          400: '#4A83AA',
          500: '#2E6B95',
          600: '#1C557C',
          700: '#0F3D5C',  // primary CTA (good contrast with white text)
          800: '#0B2F47',
          900: '#071F30',  // dark header backgrounds
        },
        accent: {
          50:  '#FDF6E7',  // light gold tint
          300: '#F0CE86',
          400: '#E0A83C',  // the stripe across the top of the nav
          500: '#C88F26',
          700: '#9A6C15',
        },
      },
    },
  },
  plugins: [],
};
