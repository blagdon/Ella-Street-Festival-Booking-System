// File: Main.gs

/**
 * CRON JOB: Keep-Alive Ping
 * Prevents Supabase from pausing the project due to inactivity (7-day limit on Free Tier).
 * Set this up as a "Time-driven" trigger to run once per day.
 * 
 * Note: Requires the GAS Supabase library (or REST API fetch calls) configured in the Apps Script project settings.
 */
function pingDatabase() {
  try {
    console.log("PING: Sending keep-alive request to Supabase...");
    
    // Perform a lightweight query (fetch just 1 ID from bookings)
    // This counts as API usage and resets the inactivity timer.
    const result = Supabase.select('bookings', '?select=id&limit=1');
    
    console.log(`PING: Success. Database is active.`);
  } catch (err) {
    console.error("PING: Failed. " + err.message);
  }
}