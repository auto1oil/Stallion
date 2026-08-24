// Public product catalog for the marketing site (Home + Products pages).
// Display-only — no purchasing. Each product can link to a Product Data Sheet
// (PDS) and a Safety Data Sheet (SDS), served from /public/datasheets.
//
// Product names, categories, and slugs mirror the live auto1oil.com storefront
// (WooCommerce). Slugs for storefront products match the /product/<slug>/ URLs;
// products surfaced only by their data sheet (Synthetic Blend, High Mileage,
// Fleet, Racing, etc.) use a descriptive slug.
//
// SDS PDFs are wired below. PDS sheets are pending re-export with the current
// logo, so pdsUrl is left undefined ("coming soon") until those PDFs are added
// to /public/datasheets.

export type CatalogProduct = {
  slug: string;
  name: string;
  category: string;
  description: string;
  pdsUrl?: string;
  sdsUrl?: string;
};

export const CATALOG_CATEGORIES = [
  'Motor Oil',
  'Transmission Fluid',
  'Gear Oil',
  'Hydraulics',
  'Grease',
  'Chemicals',
] as const;

// Real auto1oil.com product line. Add Diesel and Chemicals (DEF / Window Wash /
// Coolant) products as their items are confirmed from the storefront.
export const CATALOG: CatalogProduct[] = [
  // Motor Oil — Full Synthetic
  { slug: '0w16-full-synthetic', name: '0W-16 Full Synthetic', category: 'Motor Oil',
    description: 'Ultra-low-viscosity full-synthetic oil for the latest fuel-efficient engines.' },
  { slug: '0w20-dexos', name: '0W-20 Dexos', category: 'Motor Oil',
    description: 'Full-synthetic 0W-20 meeting GM dexos1 requirements.',
    sdsUrl: '/datasheets/fs-0w20-sds.pdf' },
  { slug: '0w30-full-synthetic', name: '0W-30 Full Synthetic', category: 'Motor Oil',
    description: 'Full-synthetic 0W-30 for year-round protection in modern engines.',
    sdsUrl: '/datasheets/fs-0w30-sds.pdf' },
  { slug: '5w20-full-synthetic', name: '5W-20 Full Synthetic', category: 'Motor Oil',
    description: 'Full-synthetic 5W-20 for everyday gasoline engines.',
    sdsUrl: '/datasheets/fs-5w20-sds.pdf' },
  { slug: '5w30-dexos', name: '5W-30 Dexos', category: 'Motor Oil',
    description: 'Full-synthetic 5W-30 meeting GM dexos1 requirements.',
    sdsUrl: '/datasheets/fs-5w30-sds.pdf' },
  { slug: '5w40-full-synthetic', name: '5W-40 Full Synthetic', category: 'Motor Oil',
    description: 'Full-synthetic 5W-40 for high-output and turbocharged engines.',
    sdsUrl: '/datasheets/fs-5w40-sds.pdf' },
  { slug: 'euro-0w40-a3-b4', name: 'Euro 0W-40 A3/B4', category: 'Motor Oil',
    description: 'European-spec full-synthetic 0W-40 (ACEA A3/B4).' },
  { slug: 'euro-5w30-c3', name: 'Euro 5W-30 C3', category: 'Motor Oil',
    description: 'European-spec full-synthetic 5W-30 (ACEA C3).' },
  { slug: 'euro-5w30-c3-vw-507', name: 'Euro 5W-30 C3 VW 507', category: 'Motor Oil',
    description: 'European-spec full-synthetic 5W-30 (ACEA C3, VW 507.00).' },
  { slug: 'euro-0w30', name: 'Euro 5W-40', category: 'Motor Oil',
    description: 'European-spec full-synthetic 5W-40.' },
  { slug: 'euro-5w40-a3-b4', name: 'Euro 5W-40 A3/B4', category: 'Motor Oil',
    description: 'European-spec full-synthetic 5W-40 (ACEA A3/B4).' },

  // Motor Oil — High Mileage
  { slug: 'hm-5w20', name: 'High Mileage 5W-20', category: 'Motor Oil',
    description: 'High-mileage 5W-20 with added seal conditioners for engines over 75k miles.',
    sdsUrl: '/datasheets/hm-5w20-sds.pdf' },
  { slug: 'hm-5w30', name: 'High Mileage 5W-30', category: 'Motor Oil',
    description: 'High-mileage 5W-30 with added seal conditioners for engines over 75k miles.',
    sdsUrl: '/datasheets/hm-5w30-sds.pdf' },

  // Motor Oil — Synthetic Blend
  { slug: 'sb-5w20', name: 'Synthetic Blend 5W-20', category: 'Motor Oil',
    description: 'Synthetic-blend 5W-20 for everyday gasoline engines.',
    sdsUrl: '/datasheets/sb-5w20-sds.pdf' },
  { slug: 'sb-5w30', name: 'Synthetic Blend 5W-30', category: 'Motor Oil',
    description: 'Synthetic-blend 5W-30 for everyday gasoline engines.',
    sdsUrl: '/datasheets/sb-5w30-sds.pdf' },
  { slug: 'sb-10w30', name: 'Synthetic Blend 10W-30', category: 'Motor Oil',
    description: 'Synthetic-blend 10W-30 (API SN, GF-5) for gasoline engines.',
    sdsUrl: '/datasheets/sb-10w30-sds.pdf' },
  { slug: 'sb-15w40', name: 'Synthetic Blend 15W-40', category: 'Motor Oil',
    description: 'Synthetic-blend 15W-40 for mixed gas and diesel fleets.',
    sdsUrl: '/datasheets/sb-15w40-sds.pdf' },
  { slug: 'fleet-sb-10w30-cj4', name: 'Fleet SB 10W-30 CJ-4', category: 'Motor Oil',
    description: 'Synthetic-blend 10W-30 heavy-duty diesel oil meeting API CJ-4.',
    sdsUrl: '/datasheets/fleet-sb-10w30-cj4-sds.pdf' },

  // Motor Oil — Racing
  { slug: 'racing-oil', name: 'Racing Oil', category: 'Motor Oil',
    description: 'High-performance racing oil for competition engines.',
    sdsUrl: '/datasheets/racing-oil-sds.pdf' },

  // Transmission Fluid
  { slug: 'atf-dex-iii-mercon', name: 'ATF Dex III/Mercon', category: 'Transmission Fluid',
    description: 'Automatic transmission fluid for Dexron III / Mercon applications.' },
  { slug: 'atf-low-viscosity', name: 'ATF LV', category: 'Transmission Fluid',
    description: 'Low-viscosity automatic transmission fluid for modern transmissions.',
    sdsUrl: '/datasheets/atf-lv-sds.pdf' },
  { slug: 'atf-4', name: 'ATF+4', category: 'Transmission Fluid',
    description: 'Automatic transmission fluid meeting Chrysler ATF+4 specifications.' },
  { slug: 'atf-heavy-duty-tes-295', name: 'ATF HD (TES 295)', category: 'Transmission Fluid',
    description: 'Heavy-duty automatic transmission fluid meeting Allison TES 295.' },
  { slug: 'cvt', name: 'CVT', category: 'Transmission Fluid',
    description: 'Continuously variable transmission fluid for CVT-equipped vehicles.' },
  { slug: 'full-synthetic-heavy-duty-50w-trans', name: 'FS HD 50W Trans', category: 'Transmission Fluid',
    description: 'Full-synthetic heavy-duty SAE 50 transmission fluid.' },

  // Gear Oil
  { slug: '80w90', name: '80W-90 Gear Oil', category: 'Gear Oil',
    description: 'Conventional 80W-90 GL-5 gear oil for differentials and gearboxes.',
    sdsUrl: '/datasheets/80w90-sds.pdf' },
  { slug: '75w90', name: '75W-90 Gear Oil', category: 'Gear Oil',
    description: 'Synthetic 75W-90 GL-5 gear oil for differentials and gearboxes.',
    sdsUrl: '/datasheets/75w90-sds.pdf' },
  { slug: '75w140', name: '75W-140 Gear Oil', category: 'Gear Oil',
    description: 'Synthetic 75W-140 GL-5 gear oil for high-load applications.',
    sdsUrl: '/datasheets/75w140-sds.pdf' },
  { slug: '85w140', name: '85W-140 Gear Oil', category: 'Gear Oil',
    description: 'Conventional 85W-140 GL-5 gear oil for heavy-duty use.' },

  // Hydraulics
  { slug: 'mvi-aw-32-hydraulic-fluid', name: 'MVI AW 32 Hydraulic Fluid', category: 'Hydraulics',
    description: 'Anti-wear AW 32 hydraulic fluid with a multi-viscosity index.' },
  { slug: 'mvi-aw-46-hydraulic-fluid', name: 'MVI AW 46 Hydraulic Fluid', category: 'Hydraulics',
    description: 'Anti-wear AW 46 hydraulic fluid with a multi-viscosity index.' },
  { slug: 'mvi-aw-68-hydraulic-fluid', name: 'MVI AW 68 Hydraulic Fluid', category: 'Hydraulics',
    description: 'Anti-wear AW 68 hydraulic fluid with a multi-viscosity index.' },

  // Grease
  { slug: 'hi-temp-moly-ep-2-grease', name: 'Hi-Temp Moly EP 2 Grease', category: 'Grease',
    description: 'High-temperature moly extreme-pressure NLGI 2 grease.' },
  { slug: 'super-moly-ep-2-grease', name: 'Super Moly EP 2 Grease', category: 'Grease',
    description: 'Heavy-duty moly extreme-pressure NLGI 2 grease.' },
  { slug: 'hi-temp-red-lithium-nlgi-2-grease', name: 'Hi-Temp Red Lithium NLGI 2 Grease', category: 'Grease',
    description: 'High-temperature red lithium-complex NLGI 2 grease.' },
];
