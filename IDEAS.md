# Future ideas / parked

## Shipped 2026-05-21

### Salesman visit logging + SMS daily summary
- New `salesman` role; Jed, Mark, Shelby, Black set up
- `/salesman` page: tap "Log visit", fill business name / city /
  contact / notes, auto-timestamped
- End-of-day "Text summary to admins" button opens iMessage with the
  day's stops pre-typed and admin phone numbers as recipients
- `/admin/salesman-visits` for admins: filter by date + salesman, CSV
  export, delete entries
- Admin/users page edits phone numbers
- Backed by `salesman_visits` table + `profiles.phone` column

### Phone dispatch setup (verified)
- Anthropic's cloud Claude Code (claude.ai mobile app or web) connects
  to a GitHub repo and edits/commits without needing the laptop on
- Vercel auto-deploys from `main` → live site updates in ~2 min
- Confirmed working with the auto1-dispatch repo

---

## Still parked

## Phone → desktop Claude dispatch

Goal: send a job from phone, have Claude execute it remotely with full access to GitHub, Vercel, Supabase.

### Path A — SSH + Termius (parked: requires laptop always on)
- Enable Remote Login in macOS Sharing settings
- Install Tailscale on Mac + phone (free, private VPN between own devices)
- Install Termius on phone (syncs with Mac install)
- SSH to Mac, run `claude`
- Pro: full Claude Code power, all MCPs available
- Con: Mac must be awake

### Path B — Cloud Claude Code (CONFIRMED, recommended)
Flow: phone → claude.ai → cloud Claude session connected to GitHub repo →
edits & pushes to `main` → Vercel auto-deploys → live site updated.
Mac doesn't need to be on.

Already in place:
- GitHub repo: github.com/auto1oil/auto1-dispatch
- Vercel project auto-deploys from main branch
- Live site: https://auto1oil.vercel.app

Setup needed next time:
1. Phone → claude.ai → start Claude Code session
2. Authorize Anthropic to access the auto1-dispatch repo
3. (Optional) Connect Supabase + Vercel MCPs to the cloud session for DB/deploy access
4. Chat: "do X" → it does X via git push → Vercel deploys

Caveats:
- Cloud session doesn't inherit local MCPs — need to re-auth integrations per session
- Uses claude.ai plan tokens, separate from Claude Code (Mac) plan
- Best for clear, small changes. Big refactors still easier at the Mac.

### Path C — Queue pattern (kludgy backup)
- Phone writes job to GitHub Issue
- Cron on Mac (when on) polls for new issues, spawns Claude Code
- Status posted back as issue comment
- Pro: works through any firewall
- Con: lag, requires Mac to be on at some point

### Next time
Recommend exploring Path B first since it doesn't depend on the laptop being awake.
For things that genuinely need local file access, fall back to Path A.
