// Guided in-app PDF form configs. Each config maps friendly form inputs to the
// real AcroForm field names in the blank PDFs under /public/forms. The
// FillablePdfForm component renders the inputs, fills the official PDF with
// pdf-lib, flattens it, and saves it as the customer's document — so customers
// fill and submit without downloading/printing.
//
// Field names + positions were taken directly from the blank PDFs.

export type FormFieldSpec =
  | { kind: 'text'; field: string; label: string; required?: boolean; placeholder?: string; help?: string; full?: boolean }
  | { kind: 'radio'; label: string; required?: boolean; options: { label: string; field: string }[] }
  | { kind: 'tin' }; // W-9 SSN/EIN — special handling in the component

export type PdfFormConfig = {
  docType: 'profile_sheet' | 'tax_exempt' | 'fein';
  blankUrl: string;
  title: string;
  intro?: string;
  // SSN/EIN target fields for the 'tin' input (W-9 only).
  tin?: { ssn: [string, string, string]; ein: [string, string] };
  sections: { heading?: string; fields: FormFieldSpec[] }[];
};

// ---- W-9 (doc_type 'fein') -------------------------------------------------
const W9 = 'topmostSubform[0].Page1[0]';
export const W9_CONFIG: PdfFormConfig = {
  docType: 'fein',
  blankUrl: '/forms/w-9.pdf',
  title: 'W-9 — Request for Taxpayer Identification Number',
  intro:
    'Fill this out as it appears on your tax return. We use it for your federal tax ID on file.',
  tin: {
    ssn: [`${W9}.f1_11[0]`, `${W9}.f1_12[0]`, `${W9}.f1_13[0]`],
    ein: [`${W9}.f1_14[0]`, `${W9}.f1_15[0]`],
  },
  sections: [
    {
      fields: [
        { kind: 'text', field: `${W9}.f1_01[0]`, label: 'Name (as shown on your income tax return)', required: true, full: true },
        { kind: 'text', field: `${W9}.f1_02[0]`, label: 'Business name / disregarded entity name (if different)', full: true },
        {
          kind: 'radio',
          label: 'Federal tax classification',
          required: true,
          options: [
            { label: 'Individual / sole proprietor', field: `${W9}.Boxes3a-b_ReadOrder[0].c1_1[0]` },
            { label: 'C corporation', field: `${W9}.Boxes3a-b_ReadOrder[0].c1_1[1]` },
            { label: 'S corporation', field: `${W9}.Boxes3a-b_ReadOrder[0].c1_1[2]` },
            { label: 'Partnership', field: `${W9}.Boxes3a-b_ReadOrder[0].c1_1[3]` },
            { label: 'Trust / estate', field: `${W9}.Boxes3a-b_ReadOrder[0].c1_1[4]` },
            { label: 'Limited liability company (LLC)', field: `${W9}.Boxes3a-b_ReadOrder[0].c1_1[5]` },
            { label: 'Other', field: `${W9}.Boxes3a-b_ReadOrder[0].c1_1[6]` },
          ],
        },
        { kind: 'text', field: `${W9}.Boxes3a-b_ReadOrder[0].f1_03[0]`, label: 'If LLC, tax classification (C, S, or P)', placeholder: 'C / S / P' },
      ],
    },
    {
      heading: 'Address',
      fields: [
        { kind: 'text', field: `${W9}.Address_ReadOrder[0].f1_07[0]`, label: 'Address (number, street, apt/suite)', required: true, full: true },
        { kind: 'text', field: `${W9}.Address_ReadOrder[0].f1_08[0]`, label: 'City, state, and ZIP code', required: true, full: true },
      ],
    },
    {
      heading: 'Taxpayer ID number — enter your SSN or EIN',
      fields: [{ kind: 'tin' }],
    },
  ],
};

// ---- Customer profile sheet (doc_type 'profile_sheet') ---------------------
export const PROFILE_CONFIG: PdfFormConfig = {
  docType: 'profile_sheet',
  blankUrl: '/forms/customer-profile.pdf',
  title: 'Customer profile sheet',
  intro: 'Tell us about your business. This sets up your account.',
  sections: [
    {
      heading: 'Business',
      fields: [
        { kind: 'text', field: 'Company54_es_:signer:company', label: 'Business / company name', required: true, full: true },
        { kind: 'text', field: 'Federal ID Number President  CEO', label: 'Federal ID # / President / CEO', full: true },
        { kind: 'text', field: 'Email Phone', label: 'Contact email & phone', full: true },
        { kind: 'text', field: 'What email would you like invoices sent to Email', label: 'Email for invoices', full: true },
        { kind: 'text', field: 'Account Type', label: 'Account type (e.g. COD, Charge)' },
        { kind: 'text', field: 'Account COD Charge  Amount Requested', label: 'Credit amount requested (if charge account)' },
      ],
    },
    {
      heading: 'Addresses',
      fields: [
        { kind: 'text', field: 'Billing Address', label: 'Billing address', full: true },
        { kind: 'text', field: 'City State Zip', label: 'Billing city, state, ZIP', full: true },
        { kind: 'text', field: 'Shipping Address if different', label: 'Shipping address (if different)', full: true },
        { kind: 'text', field: 'City State Zip_2', label: 'Shipping city, state, ZIP', full: true },
      ],
    },
    {
      heading: 'Trade references',
      fields: [
        { kind: 'text', field: 'Trade ReferencesRow1', label: 'Reference 1 — company' },
        { kind: 'text', field: 'Contact NameRow1', label: 'Reference 1 — contact' },
        { kind: 'text', field: 'EmailRow1', label: 'Reference 1 — email' },
        { kind: 'text', field: 'PhoneRow1', label: 'Reference 1 — phone' },
        { kind: 'text', field: 'Trade ReferencesRow2', label: 'Reference 2 — company' },
        { kind: 'text', field: 'Contact NameRow2', label: 'Reference 2 — contact' },
        { kind: 'text', field: 'EmailRow2', label: 'Reference 2 — email' },
        { kind: 'text', field: 'PhoneRow2', label: 'Reference 2 — phone' },
        { kind: 'text', field: 'Trade ReferencesRow3', label: 'Reference 3 — company' },
        { kind: 'text', field: 'Contact NameRow3', label: 'Reference 3 — contact' },
        { kind: 'text', field: 'EmailRow3', label: 'Reference 3 — email' },
        { kind: 'text', field: 'PhoneRow3', label: 'Reference 3 — phone' },
      ],
    },
    {
      heading: 'Bank reference',
      fields: [
        { kind: 'text', field: 'Bank ReferenceRow1', label: 'Bank name' },
        { kind: 'text', field: 'Contact NameRow1_2', label: 'Bank contact' },
        { kind: 'text', field: 'EmailRow1_2', label: 'Bank email' },
        { kind: 'text', field: 'PhoneRow1_2', label: 'Bank phone' },
      ],
    },
    {
      heading: 'Authorization',
      fields: [
        { kind: 'text', field: 'Authorized Signature', label: 'Authorized signature (type your full name)', required: true },
        { kind: 'text', field: 'Title', label: 'Your title' },
        { kind: 'text', field: 'Date', label: 'Date', placeholder: 'MM/DD/YYYY' },
      ],
    },
  ],
};

export const PDF_FORM_CONFIGS: Partial<Record<'profile_sheet' | 'tax_exempt' | 'fein', PdfFormConfig>> = {
  fein: W9_CONFIG,
  profile_sheet: PROFILE_CONFIG,
};
