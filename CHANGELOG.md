# Changes since the MVP push began (4 Sep 2026)

Running notes toward MVP. Newest first. Bugs I found in my own work are marked
**[bug]** — those are the ones worth reading.

## In progress

### GM dashboard
- `/app/dashboard`, manager-only. Stat tiles (open now, filed today, median respond,
  median resolve), a 30-day volume chart, department table, recurring-problem list,
  and per-person figures.
- Per-person handling time runs from **pick-up**, not from submission, and the page
  says so — nobody is charged for routing delay they had no part in.
- Recurring problems is the view that earns a renewal: "Hole 12 course maintenance,
  13 times in 30 days" is something a superintendent can act on.

### Demo data realism **[bug x3]**
- **Trend spike.** Shifting history piled the seed's last day plus every open report
  onto today — the chart's final bar was 4x every other day. Resolved work is now
  spread back across the week it plausibly happened in.
- **Freshen was not idempotent.** It closed six reports *every run*, so running it
  twice took the queue from 18 to 12 to 6. Now closes down *to* a target, not *by*
  a count.
- **Overdue drift.** The same script un-acknowledged two more reports on every run,
  so overdue crept up each time. Now tops up to two rather than adding two.
- Verified stable across three consecutive runs.

### Member loop-back (the thing you asked for, now complete)
- **Member status page** at `/s/[trackingToken]` — status, their own words, and the
  reply staff chose. The token is the only credential and reads exactly one row.
- Confirmation screen now links to it, so a member can get back without an account.
- Verified no leakage: checked five resolved reports and the internal resolution
  note appears nowhere in the page source. A bogus token 404s.

### Queue ordering **[bug]**
- Scheduled work was sorting to the top of the staff queue. Something booked for
  Tuesday outranked a cart broken down right now. Scheduled items now sink below
  active work; urgency and age still order within each group.
