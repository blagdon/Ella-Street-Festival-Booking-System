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

const server = http.createServer((req, res) => {
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
    console.log(`CSP connect-src widened for: ${TEST_SUPABASE_URL}`);
    console.log('In the browser console: esfUseTestProject(url, anonKey) then reload.');
  } else {
    console.log('No .env.test found — CSP not widened, production config only.');
  }
});
