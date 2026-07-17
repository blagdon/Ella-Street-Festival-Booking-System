// Grep-guard for innerHTML assignments that interpolate dynamic content
// without going through escapeHtml() first — mirrors .githooks/pre-commit's
// sibling-Edge-Function-call guard, same motivating incident: four real XSS
// gaps (map.js's public search-box toast, page-login.js's reset-email
// confirmation, page-email-admin.js's template subject, locations.js's one
// unescaped booking id) shipped and were only caught by a manual audit.
//
// Deliberately not a full parser, same "noisy but better than nothing"
// tradeoff as the sibling-call guard: flags any `.innerHTML = ` / `+= `
// assignment whose right-hand side contains dynamic content (a `${...}`
// interpolation, or a `+` string concatenation) with no `escapeHtml` call
// anywhere in that same assignment. Static-only markup (loading spinners,
// SVG icons, fixed strings) has no dynamic content and is never flagged.
//
// Known blind spot, accepted on purpose: this can't trace data flow across
// function boundaries — it wouldn't catch map.js's actual bug (an unescaped
// `message` *parameter* interpolated inside a shared showToast() helper,
// with the real unescaped value coming from a different function entirely).
// It only catches "forgot to escape at the interpolation site", not
// "unescaped value flows in through a shared helper".
//
// False positive? Add `// innerhtml-safe: <reason>` on the same line as the
// `.innerHTML` assignment to suppress it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const JS_DIR = join(ROOT, 'js');
const EXCLUDE_DIRS = new Set(['vendor']);

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function lineTextAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

// Finds the end of the RHS starting at `start` (index right after the
// assignment operator). Template literals are scanned to their matching
// closing backtick, tracking `${...}` brace depth so a `}` inside an
// interpolated expression doesn't get mistaken for anything meaningful, and
// so a backtick is only treated as the closing delimiter outside of an
// active `${...}`. Plain (non-template-literal) assignments are scanned to
// the next top-level `;`.
function findRhsEnd(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;

  if (text[i] === '`') {
    i++;
    let braceDepth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (braceDepth === 0 && ch === '`') return i + 1;
      if (text.startsWith('${', i)) { braceDepth++; i += 2; continue; }
      if (braceDepth > 0 && ch === '{') braceDepth++;
      if (braceDepth > 0 && ch === '}') braceDepth--;
      i++;
    }
    return text.length;
  }

  // Plain expression (string concatenation, ternary, etc.) — scan to the
  // next top-level semicolon, skipping over nested strings/template literals
  // so a `;` inside one of those doesn't end the scan early.
  while (i < text.length) {
    const ch = text[i];
    if (ch === ';') return i + 1;
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
    }
    i++;
  }
  return text.length;
}

const ASSIGNMENT_RE = /\.innerHTML\s*\+?=(?!=)/g;

function checkFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const findings = [];
  let match;
  ASSIGNMENT_RE.lastIndex = 0;

  while ((match = ASSIGNMENT_RE.exec(text))) {
    const rhsStart = match.index + match[0].length;
    const rhsEnd = findRhsEnd(text, rhsStart);
    const rhs = text.slice(rhsStart, rhsEnd);

    const hasDynamicContent = /\$\{/.test(rhs) || /[^=!<>]\+[^=]/.test(rhs);
    if (!hasDynamicContent) continue;
    if (/escapeHtml\s*\(/.test(rhs)) continue;

    const assignmentLine = lineTextAt(text, match.index);
    if (/innerhtml-safe/i.test(assignmentLine)) continue;

    findings.push({
      line: lineNumberAt(text, match.index),
      snippet: assignmentLine.trim().slice(0, 160),
    });
  }
  return findings;
}

const files = collectJsFiles(JS_DIR);
let totalFindings = 0;

for (const file of files) {
  const findings = checkFile(file);
  if (findings.length === 0) continue;
  totalFindings += findings.length;
  const rel = relative(ROOT, file);
  for (const f of findings) {
    console.log(`${rel}:${f.line}: ${f.snippet}`);
  }
}

if (totalFindings > 0) {
  console.log('');
  console.log(`check-unescaped-innerhtml: found ${totalFindings} innerHTML assignment(s) with`);
  console.log('dynamic content and no escapeHtml() call — four real XSS gaps shipped this way');
  console.log('(see js/map.js, js/page-login.js, js/page-email-admin.js, js/locations.js history).');
  console.log('');
  console.log('Wrap the interpolated value in escapeHtml(), or if it is genuinely already-safe');
  console.log('(a number, a fixed enum, an already-escaped variable), add');
  console.log('`// innerhtml-safe: <reason>` on the same line to suppress this check.');
  process.exit(1);
}

process.exit(0);
