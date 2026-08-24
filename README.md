# Auto1 Oil Dispatch — Setup Guide

Hi Cody. This is the complete setup guide for the dispatch app. Total time:
about 30 minutes if nothing goes weird. Each step has a screenshot description
so you know what you're looking for.

If you get stuck on any step, paste the error message back to me in chat and
I'll get you unstuck.

---

## What you're building

A web app at a URL like `auto1-oil-dispatch.vercel.app` that you and your team
can log into from any computer or phone.

User roles:
- **master_admin** — you. Full access, including deleting delivery log entries.
- **admin** — Jason, Dallin, Asa, Kenna. Manage orders, hours, users, fuel prices.
- **salesman** — Jed, Mark, Shelby, Black. Log customer visits from the field,
  text end-of-day summaries to admins.
- **driver** — default for new signups. See orders, mark delivered, upload
  signed invoices, log hours.

---

## Before you start

You need three free accounts. Sign up for these in any order:

1. **GitHub** — github.com — free, just an email + password
2. **Supabase** — supabase.com — sign in with GitHub (one click)
3. **Vercel** — vercel.com — sign in with GitHub (one click)

Done? Good. Here we go.

---

## Step 1 — Install Node.js on your Mac (5 min)

This lets your Mac run the build commands.

1. Go to **nodejs.org**
2. Download the "LTS" version (the green button on the left)
3. Open the downloaded `.pkg` file and click through the installer
4. Open **Terminal** (Cmd+Space, type "Terminal", hit Enter)
5. Type `node --version` and hit Enter. You should see something like `v20.x.x`

If you see a version number, you're good.

---

## Step 2 — Set up Supabase (10 min)

This is your database and login system.

1. Go to **supabase.com** and click "Start your project"
2. Click "New project"
3. Fill in:
   - Name: `auto1-oil-dispatch`
   - Database password: **make a strong one and save it somewhere** (you
     won't need it for normal use, but you might need it later)
   - Region: pick **West US (Oregon)** — closest to Utah
4. Click "Create new project". Wait ~2 min for it to spin up.

### Step 2a — Run the database setup SQL

This single file sets up every table, every RLS policy, every trigger,
and the `invoices` storage bucket. Safe to re-run.

1. In Supabase, click the **SQL Editor** icon on the left (looks like `</>`)
2. Click "New query"
3. Open the file `supabase-setup.sql` from this project folder
4. Copy ALL of it, paste into the SQL editor
5. Click "Run" (bottom right). You should see "Success. No rows returned."

If for some reason it complains about creating the bucket, do it manually:
**Storage → New bucket → name = `invoices` → Public unchecked → Save.**
Then re-run the SQL.

### Step 2b — Get your API keys

1. Click the **Settings** icon (gear, bottom left)
2. Click "API" in the settings menu
3. You'll see two values you need to copy somewhere safe:
   - **Project URL** — looks like `https://abcdefg.supabase.co`
   - **anon public** key — long string starting with `eyJ...`

Save these two in a note for the next step.

### Step 2c — Create your first admin user (you)

1. Click **Authentication** on the left
2. Click "Add user" → "Create new user"
3. Enter your email and a password
4. **IMPORTANT**: Check the "Auto Confirm User" box
5. Click "Create user"
6. Now go to **SQL Editor** → New query, and run this (replace your email):
   ```sql
   update public.profiles
   set role = 'master_admin',
       full_name = 'Cody',
       phone = '+18015551234'
   where email = 'YOUR-EMAIL@example.com';
   ```
7. Click Run.

You're now a master_admin. The phone number is used for the salesman
end-of-day SMS summary — store it in `+1` country-code format.

You can repeat this process for other admins/drivers/salesmen later
(replace `role = 'master_admin'` with `'admin'`, `'driver'`, or `'salesman'`).

---

## Step 3 — Push the project to GitHub (5 min)

1. Go to **github.com** and click the "+" in the top right → "New repository"
2. Repository name: `auto1-oil-dispatch`
3. Set to **Private**
4. Don't check any of the "Initialize" boxes
5. Click "Create repository"
6. GitHub now shows you a page with commands. Keep this tab open.

In Terminal, navigate to the project folder (drag the folder into Terminal
after typing `cd `, then hit Enter), then run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/auto1-oil-dispatch.git
git push -u origin main
```

(Replace `YOUR-USERNAME` with your actual GitHub username.)

If git asks you to log in, follow the prompts. GitHub has switched to using
"Personal Access Tokens" instead of passwords — if you hit that wall, tell me
and I'll walk you through it.

---

## Step 4 — Deploy to Vercel (5 min)

1. Go to **vercel.com**, sign in with GitHub
2. Click "Add New" → "Project"
3. Find `auto1-oil-dispatch` in your repo list, click "Import"
4. **Environment Variables** section — add these two:
   - `NEXT_PUBLIC_SUPABASE_URL` = (your Project URL from step 2b)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = (your anon public key from step 2b)
5. Click "Deploy"
6. Wait ~2 min. When done you'll get a URL like
   `auto1-oil-dispatch-abc123.vercel.app`

---

## Step 5 — Try it out

1. Go to your Vercel URL
2. Sign in with the email + password you created in step 2c
3. You should land on the admin orders page

Click "+ New order" and create a test order. Confirm it shows up.

---

## Step 6 — Add your team

For each person who needs access:

1. **Supabase** → Authentication → Add user → Create new user
2. Use their email, set a temporary password, check "Auto Confirm"
3. Send them their email + temporary password
4. Tell them to sign in at your Vercel URL and change their password under
   their account
5. In Supabase SQL Editor, set their role (drivers can skip this — `driver`
   is the default):
   ```sql
   -- For an admin (e.g. Jason)
   update public.profiles
   set role = 'admin', full_name = 'Jason', phone = '+18015551234'
   where email = 'jason@example.com';

   -- For a salesman (e.g. Jed)
   update public.profiles
   set role = 'salesman', full_name = 'Jed'
   where email = 'jed@example.com';
   ```

**Tip:** admin phone numbers are used as the recipients of the salesman
end-of-day SMS summary. Salesmen don't need a phone on file.

---

## Custom domain (optional, anytime later)

Want it to live at `dispatch.auto1oil.com` instead of the vercel.app URL?
Vercel → your project → Settings → Domains. Add the domain, follow the DNS
instructions. ~$15/yr for the domain if you don't already own one.

---

## When stuff breaks

- **"Can't sign in"** — double-check the user is "Confirmed" in Supabase
  Authentication
- **"Page just shows loading"** — usually a Supabase env var typo. Check
  Vercel → Settings → Environment Variables
- **"Driver can see admin pages"** — the `profiles.role` field for that user
  is set to `admin` in the database. Update it to `driver`.
- **"Anything else"** — paste the error to me in chat

---

## What's NOT in this version (Phase 2 ideas)

These are easy to add later:
- QuickBooks integration (auto-pull invoice numbers)
- Push/SMS notifications when orders are assigned (current SMS is salesman-
  triggered only — admin-triggered SMS would need a provider like Twilio)
- Automatic end-of-day SMS (currently the salesman taps Send themselves —
  could be cron-driven via Vercel + Twilio)
- Customer signature email receipts
- Mileage/fuel-use tracking per truck
- Inventory tracking for PCMO loads

We talked about phasing it. Get this one running, use it for a few weeks,
and we'll layer on whatever proves useful.

