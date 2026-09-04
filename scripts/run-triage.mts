/**
 * Invoke the triage function by hand.
 *
 * The scheduled job does this every minute; this is for when you want it now.
 * There is deliberately only one implementation — it runs in Supabase, and this
 * calls it rather than reimplementing it.
 */
const url = "https://nfyshykwwtiwkluwiuyf.supabase.co/functions/v1/triage";
const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  },
  body: "{}",
});
console.log(res.status, await res.text());
