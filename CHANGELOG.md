# Changes since the MVP push began (4 Sep 2026)

Running notes toward MVP. Newest first. Bugs I found in my own work are marked
**[bug]** — those are the ones worth reading.

## In progress

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
