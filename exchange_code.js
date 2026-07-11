/**
 * exchange_code.js
 * Run this script to exchange your Zoho Authorization Code for a Refresh Token.
 * 
 * Usage:
 * 1. Open the browser link provided.
 * 2. Click "Accept".
 * 3. Copy the URL of the page you are redirected to.
 * 4. Paste the full URL or code below in the `AUTH_CODE` variable.
 * 5. Run `node exchange_code.js` in your terminal.
 */

// Paste the code or the full redirected URL here:
const AUTH_CODE = "1000.73950b8194db78e24fb80f46d2990ab4.ae2cf5cf55c1bb5d2bb8a7d75d9fb403";

// Supabase Configuration
const SUPABASE_URL = process.env.SUPABASE_URL || "https://rsnxhuhibglieofikkpo.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJzbnhodWhpYmdsaWVvZmlra3BvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2Nzg5MjcsImV4cCI6MjA4NTI1NDkyN30.QNrMVCc9FFdIAR4wRv6g4V4p2JA8pbCoaf8zLRuu0fw";

async function run() {
  if (!AUTH_CODE || AUTH_CODE.includes("PASTE_YOUR_")) {
    console.error("Error: Please paste your Zoho Authorization Code or redirected URL in the AUTH_CODE variable first.");
    return;
  }

  // Fetch settings from Supabase
  let settings;
  try {
    const url = `${SUPABASE_URL}/rest/v1/settings?select=key,value`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    settings = {};
    data.forEach(item => {
      settings[item.key] = item.value;
    });
  } catch (err) {
    console.error("Error fetching Zoho configuration from Supabase settings table:", err.message);
    return;
  }

  const clientId = settings.zoho_client_id;
  const clientSecret = settings.zoho_client_secret;
  const accountsDomain = settings.zoho_accounts_domain || "https://accounts.zoho.eu";

  if (!clientId || !clientSecret) {
    console.error("Error: Missing zoho_client_id or zoho_client_secret in Supabase settings table.");
    return;
  }

  // Automatically clean up the code if the user pasted the full URL or query parameters
  let cleanCode = AUTH_CODE.trim();

  // Extract code from URL if full URL was pasted
  if (cleanCode.includes("?")) {
    const urlParams = new URLSearchParams(cleanCode.split("?")[1]);
    if (urlParams.has("code")) {
      cleanCode = urlParams.get("code");
    }
  } else if (cleanCode.includes("&")) {
    // If just the query string or code with trailing params was pasted
    cleanCode = cleanCode.split("&")[0];
  }

  console.log(`Exchanging Authorization Code: "${cleanCode}" for Refresh Token...`);
  const tokenUrl = `${accountsDomain}/oauth/v2/token`;
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('code', cleanCode);
  params.append('redirect_uri', 'https://app.ellastreet.co.uk');

  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    const data = await res.json();
    console.log("\nZoho API Response:");
    console.log(JSON.stringify(data, null, 2));

    if (data.refresh_token) {
      console.log("\n==================================================");
      console.log("SUCCESS! Copy your new Refresh Token:");
      console.log(data.refresh_token);
      console.log("==================================================");
    } else {
      console.log("\nFailed to retrieve refresh token. Make sure the code hasn't expired (expires in 10 minutes) and is entered correctly.");
    }
  } catch (err) {
    console.error("Error exchanging code:", err);
  }
}

run();
