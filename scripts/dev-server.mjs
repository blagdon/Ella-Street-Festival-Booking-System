// Local development server.
//
// Why this exists rather than `npx http-server`: every page pins its Supabase
// project in a CSP `connect-src` meta tag, hardcoded to production. That's
// correct for the deployed site, but it means the localhost test-project
// override in supabase-public.js can't actually reach the test project — the
// browser blocks the connection before any of our code runs.
//
// This server widens `connect-src` **in flight**, in the bytes it sends to
// localhost only. The HTML on disk (and therefore in production) is never
// modified, so the deployed CSP stays exactly as strict as it is today. That's
// the whole point of doing it here instead of editing the meta tags: a dev-only
// need must not loosen a production security header.
//
// Usage:  npm run dev
// Then set the override in the browser console and reload:
//   esfUseTestProject('https://<ref>.supabase.co', '<anon key>')
//   esfUseProduction()   // to go back
//
// Reads TEST_SUPABASE_URL from .env.test when present, so the allowed origin
// matches whatever test project is actually configured.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;

// Bind to loopback only. This server deliberately relaxes a security header;
// it must never be reachable from the network.
const HOST = '127.0.0.1';

let TEST_SUPABASE_URL = '';
try {
  process.loadEnvFile(path.join(ROOT, '.env.test'));
  TEST_SUPABASE_URL = process.env.TEST_SUPABASE_URL || '';
} catch {
  // No .env.test — fine, the server still works, the override just can't be
  // used against a test project until one is configured.
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Adds the test project (and localhost websockets) to a page's CSP
 * connect-src. Only touches the connect-src directive — every other directive
 * is left exactly as authored, so this can't silently unblock scripts or
 * frames.
 */
function widenCsp(html, label) {
  if (!TEST_SUPABASE_URL) return html;

  // NOTE the `[^"]*` for the attribute value, not `[^"']*`: a CSP policy
  // contains single quotes ('self', 'unsafe-inline'), so a character class
  // excluding them stops capturing at the first `'self'` and silently matches
  // nothing useful. That exact bug made this function a no-op that still
  // reported success — hence the warning below when nothing matches.
  let matched = false;
  const out = html.replace(
    /(<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=")([^"]*)(")/i,
    (match, before, policy, after) => {
      if (!/connect-src/i.test(policy)) return match;
      if (policy.includes(TEST_SUPABASE_URL)) { matched = true; return match; }
      matched = true;
      const widened = policy.replace(
        /connect-src([^;]*)/i,
        (_m, sources) => `connect-src${sources} ${TEST_SUPABASE_URL}`
      );
      return before + widened + after;
    }
  );

  if (!matched && /Content-Security-Policy/i.test(html)) {
    console.warn(`[dev-server] ${label}: found a CSP meta tag but could not widen connect-src — ` +
      `the test project will be blocked by CSP on this page.`);
  }
  return out;
}

function resolveFilePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  // Normalize and confine to ROOT — a dev server still shouldn't serve
  // arbitrary files from the machine.
  const candidate = path.normalize(path.join(ROOT, decoded));
  if (!candidate.startsWith(ROOT)) return null;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    return path.join(candidate, 'index.html');
  }
  return candidate;
}

// Path prefix the browser hits instead of the Supabase project directly. The
// Supabase client builds every URL as `${SUPABASE_URL}/<service>/v1/...`
// (auth, rest, functions, storage), so proxying one prefix covers all of them.
const PROXY_PREFIX = '/__supabase';

/**
 * Forwards a Supabase request through this origin.
 *
 * Why: Edge Functions pin Access-Control-Allow-Origin to the production origin
 * (_shared/cors.ts), so calling one from a localhost page fails CORS — which
 * meant Edge-Function-backed buttons (Retry, bulk email, checkout) could not be
 * clicked through locally at all. Going through this proxy makes every request
 * same-origin, so CORS never applies and no Edge Function has to change. It
 * also means CSP `connect-src 'self'` already covers it.
 *
 * Only forwards to the configured TEST project — never production — so a
 * mistake here cannot reach live data.
 */
async function proxySupabase(req, res) {
  if (!TEST_SUPABASE_URL) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Dev server has no TEST_SUPABASE_URL configured (.env.test missing).' }));
    return;
  }

  const target = TEST_SUPABASE_URL + req.url.slice(PROXY_PREFIX.length);

  // Pass headers through, minus the hop-by-hop ones and `host` (which must
  // reflect the target, not localhost, or Supabase routes the request wrong).
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }

  // Buffer the body: these are small JSON/form payloads, and streaming a
  // request body through fetch needs duplex handling that buys nothing here.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
    });

    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      // fetch has already decompressed; forwarding the original encoding or
      // length would make the browser try to decode plain bytes.
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) return;
      outHeaders[key] = value;
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, outHeaders);
    res.end(payload);
  } catch (err) {
    console.error(`[dev-server] proxy error for ${req.method} ${target}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Dev proxy failed: ' + err.message }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith(PROXY_PREFIX)) {
    proxySupabase(req, res);
    return;
  }

  const filePath = resolveFilePath(req.url === '/' ? '/index.html' : req.url);

  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  // No caching: this is a dev server and stale JS is a waste of everyone's time.
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };

  if (ext === '.html') {
    const html = widenCsp(fs.readFileSync(filePath, 'utf8'), path.basename(filePath));
    res.writeHead(200, headers);
    res.end(html);
  } else {
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dev server: http://localhost:${PORT}  (serving ${ROOT})`);
  if (TEST_SUPABASE_URL) {
    console.log(`Supabase proxy: ${PROXY_PREFIX}/* -> ${TEST_SUPABASE_URL}`);
    console.log('In the browser console: esfUseTestProject(anonKey) then reload.');
  } else {
    console.log('No .env.test found — proxy disabled, production config only.');
  }
});
