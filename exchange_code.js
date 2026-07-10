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

const CLIENT_ID = "1000.GVDCF71UNS0KT6VHLUGXRYS3RDYL1V";
const CLIENT_SECRET = "4590392a31812cc1d959a3c67cd767097a50840742";
const ACCOUNTS_DOMAIN = "https://accounts.zoho.eu";

async function run() {
  if (!AUTH_CODE || AUTH_CODE.includes("PASTE_YOUR_")) {
    console.error("Error: Please paste your Zoho Authorization Code or redirected URL in the AUTH_CODE variable first.");
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
  const tokenUrl = `${ACCOUNTS_DOMAIN}/oauth/v2/token`;
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
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
