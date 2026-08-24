# Auto 1 Oil — Features

A staff-facing summary of what the app does today. Updated as new features ship.

## 🛍️ For your customers (`/shop`)
- **Sign up** for an online account with their business name, contact info, city, and delivery address
- **Browse the product catalog** — fuels, motor oils (with weight & container size choices), Mag 1 packaged goods
- **Cart + checkout** that remembers what they last bought so reordering is one click
- **Place a delivery order** with notes for the office
- **Order history** showing status — Pending review · Invoiced · Out for delivery · Cancelled
- **Account page** to update business name, phone, city, and delivery address
- **Document uploads** — customer profile sheet, TC-721 sales-tax exemption, W-9
- Installs as a phone app (PWA) — added to home screen

## 🧑‍💼 For salesmen (`/salesman`)
- **Log Visit** — drop in a business name, city, contact person, and notes from the field
- **End-of-day text summary** — one tap opens a Messages thread to every admin with the day's visits filled in
- **Customers Visited** tab — every business anyone has visited, alphabetized, with city and visit count. Shows a ✓ Customer badge when the business is one of your existing accounts
- **Place Order on behalf of a customer** — same product catalog as the customer-facing app
- **Daily hours** auto-calculated from visit timestamps

## 🚚 For drivers (`/driver`)
- **Orders board** showing what's assigned to them today
- **Order detail** with delivery address, contents, customer notes, and the QB invoice PDF
- **Signature capture** on delivery — signed PDF saved automatically
- **Delivery Log** to review what's been delivered
- **My Hours** tracking
- Can also place orders on behalf of a customer

## 🏢 For admin / office (`/admin`)

### Order intake
- **Dispatch board** — all delivery orders, filterable, with truck assignment, driver assignment, and CSV export
- **Upload invoice** button (yellow) — manual order entry with PDF attach, for any time the QB sync isn't usable
- **+ Customer order** button (gold) — manually place an order on behalf of any customer
- **For Approval** tab — every pending customer order in one place
- **Edit a pending order** — adjust quantities, set unit prices, add or remove items before invoicing
- **Ready to send to dispatch** box at the top of the Dispatch page — invoiced orders waiting on a truck assignment

### QuickBooks integration
- One-click QB invoice creation from any customer order
- Per-line fuel pricing (priced fresh each invoice, per customer)
- Federal & state fuel taxes auto-added; sales tax skipped for TC-721 customers
- Customer + item matching via mapping table, billing history, or auto-create
- Invoice PDF auto-attached to the order for the driver to see
- Sync your QB customer list into the app
- QB ↔ product mapping admin UI

### People & records
- **Customers** page — every customer, document checklist (profile, TC-721, W-9), inline document viewer
- **Customers Visited** — same alphabetized view as salesmen
- **Sales Log** — weekly grid showing every salesman's visits, with auto-calculated daily and weekly hours
- **Delivery Log** — full delivery history
- **Hours** — payroll-ready hours per employee
- **Fuel Prices** — daily price tracking
- **Users** — add/manage admins, salesmen, drivers

### Misc
- Notification bell with deletable in-app notifications
- Mobile-friendly throughout, installable as a PWA
