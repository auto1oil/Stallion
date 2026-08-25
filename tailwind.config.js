/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Stallion Tank: taken from the logo — near-black for headers and
        // buttons, the logo's deep red as the accent stripe and highlight.
        // Every screen reads its colors from here.
        brand: {
          50:  '#F5F5F5',  // very light grey tint
          100: '#E6E6E7',
          200: '#CBCBCD',
          300: '#A3A3A6',
          400: '#737376',
          500: '#54544F',
          600: '#3D3D3E',
          700: '#242425',  // primary CTA (near-black, white text on top)
          800: '#171718',
          900: '#0C0C0D',  // dark header backgrounds
        },
        accent: {
          50:  '#FCEDED',  // light red tint
          300: '#DE8A88',
          400: '#8E1414',  // the logo's red — stripe across the top of the nav
          500: '#701010',
          700: '#4E0A0A',
        },
      },
    },
  },
  plugins: [],
};
