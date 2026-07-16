/**
 * api/ping.js - Supabase Keep-Alive Ping
 *
 * Replaces the Google Apps Script keep-alive cron job (GAS/Main.gs).
 * Called by Vercel Cron on the schedule defined in vercel.json.
 *
 * Performs a lightweight REST query against the Supabase REST API
 * (select 1 row from locations) which counts as API activity and
 * resets the Supabase free-tier inactivity timer (7-day limit).
 * Queries `locations`, not `bookings` - anon lost all direct access to
 * `bookings` in the 2026-07-16 security fix (see HANDOVER.md's "Public
 * visitor-facing data access" section), but `locations` still has an
 * unconditional `USING (true)` anon SELECT policy, so it works regardless
 * of whether any rows exist.
 *
 * Required Vercel Environment Variables:
 *   SUPABASE_URL      - e.g. https://rsnxhuhibglieofikkpo.supabase.co
 *   SUPABASE_ANON_KEY - the project anon/public key
 *
 * The endpoint is protected by CRON_SECRET that Vercel automatically
 * sets in the Authorization header when invoking scheduled functions.
 * Manual invocations without the secret will receive a 401.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader !== "Bearer " + cronSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("PING: Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.");
    return res.status(500).json({ error: "Server misconfiguration: missing Supabase credentials." });
  }

  try {
    console.log("PING: Sending keep-alive request to Supabase...");

    const queryUrl = supabaseUrl + "/rest/v1/locations?select=id" + "&limit=1";
    const response = await fetch(queryUrl, {
      method: "GET",
      headers: {
        "apikey": supabaseKey,
        "Authorization": "Bearer " + supabaseKey,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error("Supabase responded with " + response.status + ": " + body);
    }

    const data = await response.json();
    console.log("PING: Success. Database is active. Rows returned: " + data.length);

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      message: "Supabase keep-alive ping successful.",
    });
  } catch (err) {
    console.error("PING: Failed.", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
