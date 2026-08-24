# Stallion — Features

A staff-facing summary of what the app does today. Updated as new features ship.

## 🎫 For the crew (`/tickets`)
- **New ticket** — customer, customer #, job #, day #, phase code, claim #,
  unit # (truck), FSR, date
- **Start / stop times** plus travel and down time — hours and the dollar
  amount are calculated as you type, so nothing is added up by hand
- **Tonnage** and tonnage type for tonnage-priced jobs (they bill tonnage ×
  rate instead of hours × rate)
- **Suggested rate** — the agreed rate for that job/phase is one tap away
- **Photo of the paper ticket** straight from the phone's camera, plus the
  short ticket, both compressed before upload
- **On-screen signature** for the FSR
- **Save as a draft** on the job, submit when the photo's on it
- **My tickets** — everything you've filed, filtered by stage, showing what the
  office did with it and the reason if anything came back

## 🏢 For the office (`/work-orders`)
- **Review queue** — every submitted ticket in one place, with a badge in the
  nav when something's waiting
- **Open a ticket** against the photo, fix anything that's off, then approve
- **Approve = invoice** — approving raises the customer's QuickBooks invoice in
  the same step (hours or tonnage × rate) and stamps the invoice number back on
  the ticket. If QuickBooks is down, the approval stands and the ticket keeps a
  retry button rather than losing the work
- **Send back** with a reason — the crew gets a notification and can fix it
- **All tickets** view filtered by stage: waiting, approved, funds approved,
  invoiced, sent back, drafts
- **Setup** — the QuickBooks item every ticket bills against, and the job-rate
  table the crew's form reads from

## 👷 For contractors (`/contractor`)
- **Work orders** — their crews' tickets, with crew days, total hours and
  finished work orders at the top
- **Approvals** — sign off on their crews' submitted days and hours
- **Short ticket upload** on any of their tickets
- **Rates** — the agreed rate per job and phase, read-only

## 💵 For the funder (`/funder`)
- **Orders** — every ticket in the system, grouped by job with the **truck
  count** per job, ticket count, and dollar total
- **Approve funds** on tickets the office has audited and approved — the
  digital replacement for the emailed ticket → Bill of Sale loop

## 🚚 Dispatch side (kept from the original app)
- Dispatch board for delivery runs, entered by an admin, with truck and driver
  assignment and CSV export
- Signature-on-delivery with the signed PDF stored against the order
- Delivery log of everything that's been run
- Customer directory with the document checklist (profile sheet, TC-721, W-9),
  QuickBooks customer sync, balances and invoice history
- PO log with auto-incrementing numbers

## 🧰 Everywhere
- **QuickBooks Online** — OAuth connection, customer sync, invoice creation,
  invoice PDFs
- **Time clock** — pinned to Mountain time, with location breadcrumbs while
  someone is clocked in
- **Messaging, tasks, reminders**, and a notification bell
- **Push notifications** for submitted, approved, and sent-back tickets
- **Per-role tab toggles** so a master admin can hide tabs a role doesn't need
- Installable as a phone app (PWA) with an in-app "Update now" flow
