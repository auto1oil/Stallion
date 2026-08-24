// Shared fuel-name detection so every invoice/tax/commission path recognizes
// the exact same set of gasoline products — including QuickBooks' abbreviated
// item names like "GAL:GAS 85 OCT UL 10% ETHANOL" / "GAS 91 OCT UL 10% ETHANOL".
//
// The old server-side regex only matched the spelled-out words
// (gasoline|unleaded|octane), so those abbreviated names slipped through: their
// fuel excise/hazard/cleanup taxes never attached and any tax lines an admin
// added by hand got stripped on save. Match the abbreviations too.
//
// Kept deliberately narrow with word boundaries so it can't misfire on other
// products (e.g. "gasket", "85W-140 gear oil" — no bare "gas"/"oct"/"octane").
export const GASOLINE_RE = /(gasoline|unleaded|octane|\boct\b|ethanol|\bgas\b)/;

// True when a (lowercased, bare) item name looks like gasoline.
export function isGasolineName(bare: string): boolean {
  return GASOLINE_RE.test(bare);
}
