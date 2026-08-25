# Stallion — Features

A staff-facing summary of what the app does today. Updated as new features ship.

## 📋 Orders (`/work-orders` → Orders)
- **An order is a specific job** — one day, or three months. It carries the
  agreed terms once: customer, job name and number, phase code, address, FSR,
  travel and down time, tonnage, equipment, unit — and **two rates**
- **Customer rate and hauler pay rate** are separate, with the margin shown as
  you type. A hauler is never able to read the customer rate: it lives on the
  order, and haulers have no access to the order book at all
- **Add a customer without QuickBooks** — the directory used to fill only by
  syncing, so nothing could be written until QuickBooks was connected
- **Create order** sits top right, the same place the delivery board keeps its
  Upload invoice button
- **Everything ties to the order** — haul tickets are filed against one, and
  hauler dispatches are sent for one. Picking the order on a ticket fills in
  the terms so nothing is re-keyed
- **Anything that disagrees is flagged.** A ticket at a different rate, on a
  different phase, on a different job, or worked outside the order's dates
  gets marked instead of quietly billed. The order page lists what's off, and
  the office clears each flag deliberately — recorded as who and when
- The check runs on the server on every save, so a flag can't be avoided from
  the browser, and re-saving a ticket recomputes it from scratch

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
- **Two on-screen signatures** — the driver's, and the **job foreman's** at
  the end of the day. A ticket can't be completed without the foreman's:
  it's what says someone on the customer's side agreed to these hours
- **Save as a draft** on the job, **complete** it when the photo's on it
- **My tickets** — everything you've filed, filtered by stage, showing what the
  office did with it and the reason if anything came back

## 🔍 Auditing (`/work-orders` → Approve)
- **You don't audit everything.** A ticket filed against an order, matching it
  on rate, phase, job and dates, with a photo and something to bill, has
  already been checked — those sit in a table you tick and pass in one go
- **Anything the check can't vouch for goes up top with the reason**: it
  disagrees with its order, has no order, has no photo, or has nothing to bill
- **Choose your own fields** — 24 to pick from, and the choice is saved for the
  whole office. The point is deciding from the row, not opening the ticket
- **Approve in a batch** — each one still goes through the same server check
  and raises its own QuickBooks invoice, so a batch is just N normal approvals
- The running total of what you've ticked is on the button before you press it

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
- **Company details** — the hauler keeps their own business name, contact,
  address, MC/DOT and insurance expiry current. The name is the Trucking
  Company on every haul ticket their drivers file
- **Documents** — insurance, authority, W-9 and anything else, uploaded by
  the company into a private store and read by Stallion's office from the
  same list. No more "did you send it"
- **Paperwork expires, and the app says so before you dispatch** — a missing
  or expired Certificate of Insurance or W-9 shows in red on the hauler list,
  and anything within 30 days of expiry shows amber
- **Haulers run their own drivers** — the company adds driver logins itself,
  since it's the company that knows who's driving today, not Stallion's office
- A hauler's driver sees **haul tickets and nothing else**: not the rates, not
  the fleet settings, not the order book, not another company's work
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
- **What each truck can pull** — a tractor carries a list of trailers, not one
  type, because the same unit swaps between a belly dump and an end dump week
  to week. Editable per unit, since that's what actually changes
- Sending a load that names the equipment it needs shows how many units can
  take it, and marks the ones that can't — without hiding them, since
  dispatch may know something the fleet list doesn't
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
