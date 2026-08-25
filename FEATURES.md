# Stallion — Features

A staff-facing summary of what the app does today. Updated as new features ship.

## 🎫 For the crew (`/tickets`)
- **New ticket** — customer, customer #, job #, day #, phase code, claim #,
  unit # (truck), FSR, date
- **Start / stop times** plus travel and down time — hours and the dollar
  amount are calculated as you type, so nothing is added up by hand
- **Tonnage** and tonnage type for tonnage-priced jobs (they bill tonnage ×
  rate instead of hours × rate)
- **Sixteen load lines**, same as the paper ticket — per load a scale ticket
  number, the tons, and **one-tap in and out times**: load in, load out,
  unload in, unload out. Each tap stamps the time *and* the GPS fix from the
  phone, so where the truck was is on the record next to when
- The time is taken and shown the instant the button is pressed; the fix is
  chased afterwards and attached if it arrives — a driver in a pit with no
  sky still gets an accurate time
- Loads and total tons roll up automatically, and that total is what bills
- **Everything off the paper ticket** — driver, trucking company, truck type,
  material and supplier, job address, driver time, and the signed-out block
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

## 🚛 For haulers (`/hauler`) and the office (`/haulers`)
- **Hauler directory** — every company set up to haul for Stallion, with the
  contact, MC/DOT numbers, insurance expiry (flagged red once it's past), and
  the count of trucks each one has on file
- **Send a load** to a hauler — job, date, start time, pickup and drop off,
  equipment needed, rate — and they get a notification and a push straight away
- **The hauler accepts or declines** from their phone, naming which of their
  units is taking it; a decline carries a reason back to the office
- **Accepting starts the haul ticket** with everything already known filled
  in — company, truck, job, phase, date, rate — and drops the driver straight
  into it. All that's left on site is the times and the loads
- **Their fleet** — haulers add and retire their own trucks and equipment, and
  the office picks from that same list when sending a load
- **Availability** — haulers block out the dates they can't run, by unit or for
  the whole company, and see the next fortnight as a green/red strip. The
  office sees the same thing before sending work
- A hauler can **read** their loads but never write them: accept and decline go
  through the server, so the rate they accepted at is the rate that was sent

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
