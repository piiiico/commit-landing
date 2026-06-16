/**
 * Cloudflare Pages Deployment Script for commit-landing-v2
 * Uses wrangler pages deploy — properly compiles _worker.js
 *
 * Pre-deploy guards:
 *  1. Dist-staleness check: warns if any src/ file is newer than dist/
 *  2. Live-tokens check: fetches sample Pages HTML and detects production-only tokens
 * Flags:
 *  --rebuild       Run `astro build` before deploying (ensures dist/ is fresh)
 *  --skip-voice    Skip the voice gate
 *  --skip-indexnow Skip the IndexNow ping
 *  DEPLOY_FORCE=1  Bypass divergence checks in non-interactive (CI) mode
 */

import { config } from "dotenv";
import { $ } from "bun";
import { runVoiceGate } from "/workspace/tools/voice-check/deploy-voice-gate.ts";
import { statSync, readdirSync } from "fs";
import { join } from "path";

const SECRETS_PATH = "/workspace/.secrets/cloudflare.env";

config({ path: SECRETS_PATH });

const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_GLOBAL_API_KEY!;
const CLOUDFLARE_EMAIL = process.env.CLOUDFLARE_EMAIL!;

if (!CLOUDFLARE_API_KEY || !CLOUDFLARE_EMAIL) {
  console.error("Missing Cloudflare credentials in", SECRETS_PATH);
  process.exit(1);
}

const PROJECT_NAME = "commit-landing";
const PAGES_SUBDOMAIN = "https://commit-landing.pages.dev";
const DIST_DIR = new URL("dist", import.meta.url).pathname;
const SRC_DIR = new URL("src", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// HELPERS: File-tree mtime scan
// ---------------------------------------------------------------------------

/** Return the newest modification time (ms) across all files in a directory tree. */
function newestMtime(dir: string): number {
  let max = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        max = Math.max(max, newestMtime(full));
      } else {
        try {
          const mt = statSync(full).mtimeMs;
          if (mt > max) max = mt;
        } catch {
          // Ignore permission errors on individual files
        }
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return max;
}

// ---------------------------------------------------------------------------
// GUARD 1: Dist-staleness check
// ---------------------------------------------------------------------------

async function checkDistStaleness(): Promise<boolean> {
  const srcNewest = newestMtime(SRC_DIR);
  const distNewest = newestMtime(DIST_DIR);

  if (srcNewest === 0) return true; // No src/ — skip
  if (distNewest === 0) {
    console.warn("⚠️  dist/ is empty — you probably need --rebuild before deploying.");
    return false;
  }

  if (srcNewest > distNewest) {
    const srcDate = new Date(srcNewest).toISOString();
    const distDate = new Date(distNewest).toISOString();
    console.log("");
    console.log("┌─────────────────────────────────────────────────────────────────┐");
    console.log("│  ⚠️  DIST IS STALE                                               │");
    console.log("│  src/ contains files newer than dist/ — build may be out of     │");
    console.log("│  date. Run with --rebuild to regenerate, or check that your      │");
    console.log("│  latest edits are reflected in dist/.                            │");
    console.log("└─────────────────────────────────────────────────────────────────┘");
    console.log(`  Newest src file:  ${srcDate}`);
    console.log(`  Newest dist file: ${distDate}`);
    console.log("");
    return false;
  }

  console.log("✅ Dist-staleness check: dist/ is up to date with src/");
  return true;
}

// ---------------------------------------------------------------------------
// GUARD 1b: Dist-completeness check
// ---------------------------------------------------------------------------
//
// 2026-06-13 incident + 2026-06-16 recurrence: a wave of concurrent Astro
// builds produced dist trees missing /pricing/, /quickstart/, /thesis/,
// /watchlist/, /spec/, /rankings/, /privacy/, /signup/, /windsurf/ — 9 pages
// that share no obvious build-graph property except being the heavier
// marketing routes. Wrangler uploaded the incomplete dist; CF Pages took it as
// authoritative; /pricing (sole paid surface) 404'd silently for days.
//
// GUARD 2 (live-tokens) doesn't catch this because it `continues` on local
// file-not-found ("Skipping path — local file not found"). GUARD 6
// (post-deploy) catches it after the damage is done.
//
// This guard fails BEFORE wrangler upload if any marketing page is missing
// from dist. Set of pages = SAMPLE_PATHS + the 06-13/06-16 incident list.
// Adding a page? Add it here too — the cost is one fs.existsSync per page.
const REQUIRED_DIST_PAGES = [
  "/index.html",
  "/audit/index.html",
  "/get-started/index.html",
  "/docs/index.html",
  "/pricing/index.html",
  "/quickstart/index.html",
  "/thesis/index.html",
  "/watchlist/index.html",
  "/spec/index.html",
  "/rankings/index.html",
  "/privacy/index.html",
  "/signup/index.html",
  "/windsurf/index.html",
  "/cursor/index.html",
  "/claude-code/index.html",
  "/extension/index.html",
  "/badges/index.html",
  "/compare/index.html",
  "/dashboard/index.html",
];

async function checkDistCompleteness(): Promise<boolean> {
  const { existsSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const missing: string[] = [];
  const empty: string[] = [];
  for (const path of REQUIRED_DIST_PAGES) {
    const full = join(DIST_DIR, path.slice(1));
    if (!existsSync(full)) {
      missing.push(path);
    } else if (statSync(full).size < 200) {
      empty.push(`${path} (${statSync(full).size}B — looks truncated)`);
    }
  }
  if (missing.length > 0 || empty.length > 0) {
    console.error("\n❌ DIST-COMPLETENESS CHECK FAILED");
    if (missing.length > 0) {
      console.error(`   ${missing.length} marketing page(s) missing from dist/:`);
      for (const m of missing) console.error(`     - ${m}`);
    }
    if (empty.length > 0) {
      console.error(`   ${empty.length} page(s) suspiciously small:`);
      for (const e of empty) console.error(`     - ${e}`);
    }
    console.error("   Rerun --rebuild and confirm no concurrent astro processes.");
    console.error("   See 2026-06-13/06-16 manifest-drift incidents in CLAUDE.md.");
    return false;
  }
  console.log(`✅ Dist-completeness check: all ${REQUIRED_DIST_PAGES.length} marketing pages present.`);
  return true;
}

// ---------------------------------------------------------------------------
// HELPERS: Token extraction (same logic as poc-backend/deploy.ts)
// ---------------------------------------------------------------------------

const SKIP_IDENTIFIERS = new Set([
  "abstract","arguments","async","await","boolean","break","byte","case","catch",
  "char","class","const","continue","debugger","default","delete","do","double",
  "else","enum","eval","export","extends","false","final","finally","float","for",
  "function","goto","if","implements","import","in","instanceof","int","interface",
  "let","long","native","new","null","package","private","protected","public",
  "return","short","static","super","switch","this","throw","throws","true","try",
  "typeof","undefined","var","void","while","with","yield","from","of","get","set",
  "Object","Array","String","Number","Boolean","Symbol","Map","Set","Promise",
  "Error","Math","JSON","console","process","module","require","exports","global",
  "fetch","Response","Request","Headers","FormData","Blob","URL","Date","RegExp",
  "parseInt","parseFloat","isNaN","isFinite","encodeURIComponent","decodeURIComponent",
  "toString","valueOf","prototype","constructor","length","name","message","stack",
  "then","catch","finally","resolve","reject","status","headers","body","text",
  "json","ok","method","url","type","data","error","result","success","value",
  "index","count","items","list","keys","values","entries","push","pop","shift",
  "unshift","splice","slice","join","split","map","filter","reduce","find","some",
  "every","forEach","includes","indexOf","hasOwnProperty","assign","create","keys",
  "entries","values","freeze","seal","defineProperty","getOwnPropertyNames",
  "stringify","parse","log","warn","info","debug","error","trace","group","groupEnd",
  "env","exit","argv","cwd","stdout","stderr","stdin",
  // HTML/CSS specifics — common in static pages, low signal
  "html","head","body","meta","link","script","style","title","class","href",
  "charset","content","viewport","width","initial","scale","rel","stylesheet",
  "crossorigin","anonymous","data","aria","role","tabindex","type","src","alt",
  "defer","async","module","nomodule","srcset","loading","lazy",
]);

/**
 * Normalize hashed asset references so that build-hash rotation doesn't
 * trip the divergence check. Astro/Vite stamp `/_assets/<name>.<hash>.<ext>`
 * on every build; the hash is meant to rotate. Preserve <name> and <ext>
 * so genuine new/missing assets still show up in the diff.
 *
 * 5+ false positives in one session (2026-05-28) before this fix —
 * pattern was documented in working memory under
 * `commit-landing-deploy-friction`.
 */
function normalizeAssetHashes(source: string): string {
  return source.replace(
    /(\/_assets\/[a-zA-Z0-9_-]+\.)[a-zA-Z0-9_-]{6,20}(\.[a-zA-Z]+)/g,
    "$1HASH$2",
  );
}

/**
 * Extract meaningful tokens from HTML/JS source for divergence detection.
 * Focuses on string literals ≥6 chars and identifiers ≥8 chars.
 * Shorter thresholds pick up too much HTML noise; tighter keeps signal high.
 */
function extractMeaningfulTokens(source: string): Set<string> {
  const tokens = new Set<string>();

  // String literals (single or double quoted, content ≥6 chars)
  const strRe = /(?:"([^"\\]{6,}(?:\\.[^"\\]*)*)"|'([^'\\]{6,}(?:\\.[^'\\]*)*)')/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(source)) !== null) {
    const inner = m[1] ?? m[2];
    tokens.add(`"${inner}"`);
  }

  // Identifiers ≥8 characters, not in common keyword set
  const identRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]{7,})\b/g;
  while ((m = identRe.exec(source)) !== null) {
    const id = m[1];
    if (!SKIP_IDENTIFIERS.has(id)) tokens.add(id);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// GUARD 2: Live Pages token comparison
// ---------------------------------------------------------------------------

// Sample paths to fetch from the live Pages deployment
const SAMPLE_PATHS = [
  "/index.html",
  "/pricing/index.html",
  "/blog/index.html",
];

async function checkLiveTokens(): Promise<boolean> {
  console.log("🔍 Live-tokens check: comparing dist/ vs deployed Pages...");

  let anyDivergence = false;

  for (const path of SAMPLE_PATHS) {
    const liveUrl = `${PAGES_SUBDOMAIN}${path}`;
    const localPath = join(DIST_DIR, path.slice(1)); // strip leading /

    let localContent: string;
    try {
      localContent = await Bun.file(localPath).text();
    } catch {
      console.log(`   Skipping ${path} — local file not found`);
      continue;
    }

    let liveContent: string | null = null;
    try {
      const res = await fetch(liveUrl, { signal: AbortSignal.timeout(8_000) });
      if (res.status === 404) {
        console.log(`   Skipping ${path} — not found in live deployment (new page?)`);
        continue;
      }
      if (!res.ok) {
        console.warn(`   ⚠️  ${path}: live fetch returned HTTP ${res.status} — skipping`);
        continue;
      }
      liveContent = await res.text();
    } catch (err) {
      console.warn(`   ⚠️  ${path}: could not reach live deployment — skipping (${(err as Error).message})`);
      continue;
    }

    const localTokens = extractMeaningfulTokens(normalizeAssetHashes(localContent));
    const liveTokens = extractMeaningfulTokens(normalizeAssetHashes(liveContent));

    // Find tokens present in production but absent from local dist/
    const productionOnly: string[] = [];
    for (const token of liveTokens) {
      if (!localTokens.has(token)) productionOnly.push(token);
    }

    if (productionOnly.length > 0) {
      productionOnly.sort((a, b) => {
        const aStr = a.startsWith('"');
        const bStr = b.startsWith('"');
        if (aStr !== bStr) return aStr ? -1 : 1;
        return a.localeCompare(b);
      });

      console.log(`\n  ${path}: ${productionOnly.length} production-only token(s):`);
      for (const t of productionOnly.slice(0, 20)) {
        console.log(`    - ${t}`);
      }
      if (productionOnly.length > 20) {
        console.log(`    ... and ${productionOnly.length - 20} more`);
      }
      anyDivergence = true;
    } else {
      console.log(`   ✓ ${path}: no production-only tokens`);
    }
  }

  return !anyDivergence;
}

// ---------------------------------------------------------------------------
// DIVERGENCE WARNING + CONFIRM LOGIC
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SHARED HELPER: Object-key extraction (brace-walking, not regex)
// ---------------------------------------------------------------------------
//
// Finds `const <varName> = { ... }` in `source` and returns the set of
// top-level quoted keys.  Used by GUARD 3 (hero-ref mapping) and GUARD 4
// (emitted-refs ⊆ REF_TO_SOURCE).
//
// Simple regex would mis-match nested objects; this brace-walker is correct
// for the patterns in get-started.astro.
function extractObjectKeys(source: string, varName: string): Set<string> | null {
  // Anchor on `const NAME` then jump past any TypeScript type annotation
  // (which itself may contain `{...}`) to the `=` sign and find the
  // object literal opening brace after it.
  const anchor = `const ${varName}`;
  const startIdx = source.indexOf(anchor);
  if (startIdx === -1) return null;
  const eqIdx = source.indexOf("=", startIdx);
  if (eqIdx === -1) return null;
  const openIdx = source.indexOf("{", eqIdx);
  if (openIdx === -1) return null;
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) return null;
  const body = source.slice(openIdx + 1, endIdx);
  // Match only top-level keys (depth-1). Walk the body counting braces.
  const keys = new Set<string>();
  depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && (c === "'" || c === '"')) {
      const quote = c;
      const start = i + 1;
      let j = start;
      while (j < body.length && body[j] !== quote) {
        if (body[j] === "\\") j++; // skip escape
        j++;
      }
      const key = body.slice(start, j);
      // Only count quoted strings followed by `:` (object keys, not values)
      let k = j + 1;
      while (k < body.length && /\s/.test(body[k])) k++;
      if (body[k] === ":" && /^[a-zA-Z0-9_-]+$/.test(key)) {
        keys.add(key);
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return keys;
}

// ---------------------------------------------------------------------------
// GUARD 3: HERO_BY_REF ⊇ REF_TO_SOURCE (orphan-promise prevention)
// ---------------------------------------------------------------------------
//
// /get-started.astro maintains two maps:
//   REF_TO_SOURCE — every ?ref= value the destination accepts
//   HERO_BY_REF   — every ?ref= value that gets personalized hero copy
//
// Every entry in REF_TO_SOURCE should have a matching HERO_BY_REF entry
// (the file comment block at the top of the script literally says so).
// When a ref ships in REF_TO_SOURCE without a HERO_BY_REF entry, the
// source surface promises something specific ("From the axios profile",
// "Past the audit") and the destination shows generic "Get your API key" —
// an orphan promise that breaks the conversion narrative.
//
// Pre-existing orphans diagnosed 2026-06-02:
//   pkg-profile (10 days, fixed by hero variant @23:13)
//   audit-web (static CTA on /audit/ bottom)
//   audit-web-critical (post-result CTA when CRITICAL — noscript fallback)
//   audit-web-healthy (post-result CTA when 0 CRITICAL — noscript fallback)
//
// Per CLAUDE.md self-awareness ("if a pattern recurs after a skill covers
// it, escalate to a code gate"), this guard prevents the next orphan from
// shipping silently. Comment-as-discipline failed for 10 days; this is the
// build-time check the 23:13 reflection said to escalate to.
async function checkHeroRefMapping(): Promise<boolean> {
  const filePath = join(SRC_DIR, "pages", "get-started.astro");
  let source: string;
  try {
    source = await Bun.file(filePath).text();
  } catch {
    console.warn(`⚠️  Hero-ref check: could not read ${filePath} — skipping.`);
    return true;
  }

  const refKeys = extractObjectKeys(source, "REF_TO_SOURCE");
  const heroKeys = extractObjectKeys(source, "HERO_BY_REF");
  if (!refKeys || !heroKeys) {
    console.warn(`⚠️  Hero-ref check: could not parse REF_TO_SOURCE/HERO_BY_REF — skipping.`);
    return true;
  }

  const orphans: string[] = [];
  for (const ref of refKeys) {
    if (!heroKeys.has(ref)) orphans.push(ref);
  }

  if (orphans.length > 0) {
    console.log("");
    console.log("┌─────────────────────────────────────────────────────────────────┐");
    console.log("│  ❌ ORPHAN-PROMISE: REF_TO_SOURCE has refs missing HERO_BY_REF  │");
    console.log("└─────────────────────────────────────────────────────────────────┘");
    for (const o of orphans) console.log(`  - ${o}`);
    console.log("");
    console.log("  Add a HERO_BY_REF entry for each ref above in:");
    console.log("    src/pages/get-started.astro");
    console.log("");
    return false;
  }

  console.log(`✅ Hero-ref check: ${refKeys.size} refs all have HERO_BY_REF entries`);
  return true;
}

// ---------------------------------------------------------------------------
// GUARD 4: Emitted refs ⊆ REF_TO_SOURCE (attribution-leak prevention)
// ---------------------------------------------------------------------------
//
// audit.astro is the primary source surface — it emits ?ref= values via:
//   1. Static href="/get-started?ref=<value>" anchor attributes
//   2. renderInlineForm(headline, '/get-started?ref=<value>', '<value>', ...)
//      — 3rd positional arg is the refTag (also appears in the URL literal)
//   3. renderRateLimitRescue({ ..., webRef: '<value>' })
//      — webRef is stored in api_keys.source; appears in upgradeUrl too
//
// Pattern 1 is a superset: every ref in patterns 2 and 3 also appears as a
// URL literal containing `/get-started?ref=<value>`. A single regex on the
// full audit.astro source catches them all.
//
// When a new ref is added to audit.astro but NOT to get-started.astro
// REF_TO_SOURCE, the attribution is silently dropped — api_keys.source
// records nothing, the funnel report misses the cohort.
//
// 2nd occurrence of this pattern (1st: audit-web-critical/healthy, 2026-05-22;
// 2nd: audit-web-compromised, 2026-06-10 ~2h gap). Per CLAUDE.md escalation
// rule ("2nd occurrence → code gate"), this is the guard that prevents a 3rd.
//
// NOTE (future work): proof-of-commitment/src/backend/worker.ts also maintains
// VALID_SOURCES. A cross-repo guard enforcing worker.ts VALID_SOURCES ⊇ audit.astro
// refs would close the remaining gap — out of scope for this first iteration.
async function checkEmittedRefs(): Promise<boolean> {
  const auditPath = join(SRC_DIR, "pages", "audit.astro");
  const getStartedPath = join(SRC_DIR, "pages", "get-started.astro");

  let auditSource: string;
  let getStartedSource: string;
  try {
    auditSource = await Bun.file(auditPath).text();
  } catch {
    console.warn(`⚠️  Emitted-refs check: could not read ${auditPath} — skipping.`);
    return true;
  }
  try {
    getStartedSource = await Bun.file(getStartedPath).text();
  } catch {
    console.warn(`⚠️  Emitted-refs check: could not read ${getStartedPath} — skipping.`);
    return true;
  }

  // Extract every ref value emitted via /get-started?ref=<value> in audit.astro.
  // This regex matches both relative paths (/get-started?ref=foo) and absolute
  // URLs (https://getcommit.dev/get-started?ref=foo).
  const emittedRefs = new Set<string>();
  const refEmitRe = /\/get-started\?ref=([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = refEmitRe.exec(auditSource)) !== null) {
    emittedRefs.add(m[1]);
  }
  // Also catch standalone webRef: '<value>' assignments that may not always
  // co-appear with a URL literal (belt-and-suspenders for future refactors).
  const webRefRe = /webRef\s*:\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  while ((m = webRefRe.exec(auditSource)) !== null) {
    emittedRefs.add(m[1]);
  }

  if (emittedRefs.size === 0) {
    console.warn("⚠️  Emitted-refs check: no refs found in audit.astro — skipping.");
    return true;
  }

  const refToSource = extractObjectKeys(getStartedSource, "REF_TO_SOURCE");
  if (!refToSource) {
    console.warn("⚠️  Emitted-refs check: could not parse REF_TO_SOURCE in get-started.astro — skipping.");
    return true;
  }

  const missing: string[] = [];
  for (const ref of emittedRefs) {
    if (!refToSource.has(ref)) missing.push(ref);
  }

  if (missing.length > 0) {
    console.log("");
    console.log("┌─────────────────────────────────────────────────────────────────┐");
    console.log("│  ❌ ATTRIBUTION-LEAK: audit.astro emits refs missing REF_TO_SOURCE │");
    console.log("└─────────────────────────────────────────────────────────────────┘");
    for (const r of missing) console.log(`  - ${r}`);
    console.log("");
    console.log("  Add a REF_TO_SOURCE entry for each ref above in:");
    console.log("    src/pages/get-started.astro");
    console.log("  (Also add a HERO_BY_REF entry so GUARD 3 passes.)");
    console.log("");
    return false;
  }

  console.log(`✅ Emitted-refs check: ${emittedRefs.size} refs from audit.astro all present in REF_TO_SOURCE`);
  return true;
}

// ---------------------------------------------------------------------------
// GUARD 5: No crawler-followable /api/checkout in static HTML
// ---------------------------------------------------------------------------
//
// Shipped 2026-06-07 alongside get-started.astro upgrade-button refactor.
// History: hardcoded <a href="/api/checkout?tier=…&utm_source=get-started">
// anchors on /get-started caused crawler-induced empty-customer_email Stripe
// sessions (2 USD sessions caught 2026-06-07 ~05Z). Worker now has a no-email
// gate (worker.ts L6139), but defense-in-depth requires keeping the URL out
// of static HTML so crawlers don't even hit the endpoint.
//
// Rule: ANY built page that contains the substring `href="/api/checkout`
// (in static HTML, not in JS string literals — crude grep, but the false-
// positive rate has been zero in practice) fails the deploy. JS-built URLs
// at click-time are fine — they construct the URL after user input.
//
// Exemption: HTML comments quoting the URL pattern would false-positive.
// The check counts `<a … href="/api/checkout` (anchor element + attribute)
// to avoid matching comments and JS string literals.
async function checkNoStaticCheckoutLinks(): Promise<boolean> {
  console.log("🔍 Static-checkout-link check: scanning dist/ for crawler-followable /api/checkout anchors...");
  const findings: { path: string; matches: string[] }[] = [];

  // Anchor pattern: <a … href="/api/checkout…" — the angle-bracket prefix
  // distinguishes a real DOM anchor from a JS template literal or comment.
  // Allow any whitespace and other attributes between `<a` and `href`.
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*["']\/api\/checkout\b[^"']*["']/gi;

  function scan(dir: string) {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!entry.name.endsWith(".html")) continue;
      let content: string;
      try {
        content = require("fs").readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const matches = content.match(anchorRe);
      if (matches && matches.length > 0) {
        findings.push({ path: full.replace(DIST_DIR, ""), matches });
      }
    }
  }
  scan(DIST_DIR);

  if (findings.length === 0) {
    console.log("✅ Static-checkout-link check: no crawler-followable /api/checkout anchors in dist/");
    return true;
  }

  console.log("");
  console.log(`❌ Static-checkout-link check: ${findings.length} page(s) contain crawler-followable /api/checkout anchors:`);
  for (const f of findings) {
    console.log(`   ${f.path}:`);
    for (const m of f.matches.slice(0, 3)) {
      console.log(`     - ${m.length > 120 ? m.slice(0, 120) + "…" : m}`);
    }
    if (f.matches.length > 3) console.log(`     … and ${f.matches.length - 3} more`);
  }
  console.log("");
  console.log("   These anchors get followed by crawlers and create empty-customer_email Stripe sessions.");
  console.log("   Refactor to <button> with data-tier + a click handler that builds the URL at click time.");
  console.log("   See get-started.astro handleUpgradeClick for the pattern. (Reflection 2026-06-07 ~06Z.)");
  return false;
}

async function handleDivergence(reason: string): Promise<void> {
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────────────┐");
  console.log("│  ⚠️  PRODUCTION DIVERGENCE DETECTED                              │");
  console.log(`│  ${reason.padEnd(65)}│`);
  console.log("│  Deploying will overwrite whatever is currently live.            │");
  console.log("└─────────────────────────────────────────────────────────────────┘");
  console.log("");

  const forceEnv = process.env.DEPLOY_FORCE === "1";
  const isTTY = process.stdin.isTTY;

  if (forceEnv) {
    console.log("  DEPLOY_FORCE=1 — proceeding despite divergence.\n");
    return;
  }

  if (isTTY) {
    process.stdout.write("  Type CONFIRM to proceed anyway, or anything else to abort: ");
    const answer = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", (chunk) => {
        buf += chunk;
        resolve(buf.trim());
      });
      process.stdin.resume();
    });
    if (answer !== "CONFIRM") {
      console.log("\n  Aborted. Fix the divergence before deploying.");
      process.exit(1);
    }
    console.log("");
  } else {
    console.error(
      "  Non-interactive mode: set DEPLOY_FORCE=1 to override divergence check."
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// REBUILD (--rebuild flag)
// ---------------------------------------------------------------------------

if (process.argv.includes("--rebuild")) {
  console.log("🔨 --rebuild: running astro build...\n");
  const buildResult = await $`bun run build`.cwd(new URL(".", import.meta.url).pathname).nothrow();
  if (buildResult.exitCode !== 0) {
    console.error("❌ astro build failed — aborting deploy.");
    process.exit(buildResult.exitCode);
  }
  console.log("✅ Build complete.\n");
}

// ---------------------------------------------------------------------------
// PRE-DEPLOY GUARDS
// ---------------------------------------------------------------------------

console.log("🔍 Pre-deploy guard: checking source/production divergence...\n");

const distOk = await checkDistStaleness();
const distCompleteOk = await checkDistCompleteness();
const liveOk = await checkLiveTokens();
const heroOk = await checkHeroRefMapping();
const emittedRefsOk = await checkEmittedRefs();
const noStaticCheckoutOk = await checkNoStaticCheckoutLinks();

console.log("");

if (!distCompleteOk) {
  // Hard-fail: shipping an incomplete dist destroyed the buyer journey for 3 days
  // (06-13 → 06-16). Override is a misuse — fix the build, don't deploy partial.
  console.error("Aborting deploy: dist is incomplete.");
  process.exit(1);
}

if (!distOk) {
  await handleDivergence("dist/ is older than src/ — build may be stale.");
}

if (!liveOk) {
  await handleDivergence("Live deployment has tokens not in local dist/.");
}

if (!heroOk) {
  await handleDivergence("REF_TO_SOURCE has refs without matching HERO_BY_REF entries (orphan promise).");
}

if (!emittedRefsOk) {
  await handleDivergence("audit.astro emits refs not present in get-started.astro REF_TO_SOURCE (attribution leak).");
}

if (!noStaticCheckoutOk) {
  // Hard-fail: this is a measurement-pollution + Stripe-resource bug class,
  // not a stylistic concern. handleDivergence allows CONFIRM-override, which
  // is wrong here — the gate exists precisely because the bug class was
  // missed by code review. Exit immediately unless DEPLOY_FORCE=1.
  if (process.env.DEPLOY_FORCE !== "1") {
    console.error("Aborting deploy. Set DEPLOY_FORCE=1 only if you understand the funnel-pollution risk.");
    process.exit(1);
  }
  console.log("  DEPLOY_FORCE=1 — proceeding despite static-checkout-link findings.\n");
}

if (distOk && distCompleteOk && liveOk && heroOk && emittedRefsOk && noStaticCheckoutOk) {
  console.log("✅ Pre-deploy guard: source/production in sync — proceeding.\n");
}

// ---------------------------------------------------------------------------
// VOICE GATE
// ---------------------------------------------------------------------------

if (!process.argv.includes("--skip-voice")) {
  const gate = runVoiceGate(DIST_DIR);
  if (!gate.passed) {
    process.exit(1);
  }
}

console.log(`Deploying ${DIST_DIR} → "${PROJECT_NAME}" via wrangler\n`);

const result = await $`bunx wrangler pages deploy ${DIST_DIR} --project-name=${PROJECT_NAME} --branch=main`
  .env({
    ...process.env,
    CLOUDFLARE_API_KEY,
    CLOUDFLARE_EMAIL,
  })
  .nothrow();

if (result.exitCode !== 0) {
  console.error("Deploy failed with exit code", result.exitCode);
  process.exit(result.exitCode);
}

console.log("\n✅ Deployed!");

// ---------------------------------------------------------------------------
// GUARD 6: Post-deploy critical-pages liveness check
// ---------------------------------------------------------------------------
//
// 2026-06-13 incident: production /pricing/, /quickstart/, /rankings/, /thesis/,
// /spec/, /watchlist/, /privacy/, /signup/, /windsurf/ all returned 404 with
// cache-bust — wave of concurrent background builds raced earlier deploys
// (07:06 + 07:47) and shipped a CF Pages deployment manifest missing these
// pages. /pricing/ is the SOLE conversion surface for paid upgrades; every
// CLI rate-limit overshoot (4465 audits/day on shared NAT IPs), every welcome-
// email "Enable monitoring" CTA, every README footer click hit 404. The
// pre-deploy live-tokens check passed because it SKIPS on 404 (`new page?`).
// dist-staleness passed because dist/ had OTHER newer files even with pricing
// missing in earlier intermediate state.
//
// Rule: after wrangler returns OK, fetch each critical revenue page from the
// live PROJECT subdomain with cache-bust. If any 404 / non-2xx, exit 1 loudly
// so the operator (or scheduler) knows to redeploy.
//
// Pages: pricing (paid upgrade), audit (free entry), get-started (signup),
// quickstart (CLI install), index (front door), docs (CLI reference). All are
// load-bearing for either inbound discovery or outbound revenue.
if (!process.argv.includes("--skip-post-verify")) {
  console.log("\nWaiting 8s for edge propagation, then verifying critical pages…");
  await new Promise((r) => setTimeout(r, 8_000));
  // Expanded 2026-06-16: every page in REQUIRED_DIST_PAGES — the 06-13 manifest-drift
  // pattern leaves dist intact on disk but missing on the live edge. Only a live
  // post-deploy probe catches that the wrangler upload didn't include them.
  const CRITICAL_PAGES = REQUIRED_DIST_PAGES.map((p) => p.replace(/index\.html$/, ""));
  const failed: { path: string; status: number; reason?: string }[] = [];
  for (const path of CRITICAL_PAGES) {
    const url = `${PAGES_SUBDOMAIN}${path}?cb=${Date.now()}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) {
        failed.push({ path, status: res.status });
        console.error(`  ✗ ${path} → HTTP ${res.status}`);
      } else {
        console.log(`  ✓ ${path} → HTTP ${res.status}`);
      }
    } catch (err) {
      failed.push({ path, status: -1 });
      console.error(`  ✗ ${path} → fetch error: ${(err as Error).message}`);
    }
  }

  // GUARD 6b: bare-URL canonicalization for paid-conversion surfaces.
  // 2026-06-16: /pricing (no trailing slash) silently returned 404 instead of
  // 308-redirecting to /pricing/ like every other Astro page — every CLI
  // footer CTA + `/api/checkout` crawler-fallback target was dropping to a
  // dead end on the SOLE paid-conversion URL. Worker now emits explicit 308.
  // Lock that in: bare /pricing must be 2xx OR 3xx (redirect counts as healthy).
  const BARE_CANONICAL_PAGES = ["/pricing", "/audit", "/get-started", "/docs"];
  for (const bare of BARE_CANONICAL_PAGES) {
    const url = `${PAGES_SUBDOMAIN}${bare}?cb=${Date.now()}`;
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
      // Accept 2xx (page directly served) or 3xx (canonical redirect).
      if (res.status >= 400) {
        failed.push({ path: bare, status: res.status, reason: "bare-url-canonicalization" });
        console.error(`  ✗ ${bare} (bare) → HTTP ${res.status} — should 308 to ${bare}/`);
      } else {
        console.log(`  ✓ ${bare} (bare) → HTTP ${res.status}`);
      }
    } catch (err) {
      failed.push({ path: bare, status: -1, reason: "bare-url-canonicalization" });
      console.error(`  ✗ ${bare} (bare) → fetch error: ${(err as Error).message}`);
    }
  }

  // GUARD 6c: paid-conversion pages must be Google-indexable.
  // 2026-06-16: /pricing/ served `X-Robots-Tag: noindex` from cached responses
  // (no such header in HTML, no such code path in worker source — likely a
  // stale Cloudflare dashboard rule). Worker now strips the header defensively.
  // Lock that in: indexable pages must not emit `X-Robots-Tag: noindex`.
  const INDEXABLE_PAGES = ["/", "/audit/", "/get-started/", "/pricing/", "/docs/", "/quickstart/"];
  for (const path of INDEXABLE_PAGES) {
    const url = `${PAGES_SUBDOMAIN}${path}?cb=${Date.now()}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const xrt = res.headers.get("X-Robots-Tag") || "";
      if (xrt.toLowerCase().includes("noindex")) {
        failed.push({ path, status: res.status, reason: `X-Robots-Tag: ${xrt}` });
        console.error(`  ✗ ${path} → X-Robots-Tag: ${xrt} (should be indexable)`);
      } else {
        console.log(`  ✓ ${path} → no noindex header`);
      }
    } catch (err) {
      // Already counted in pass A above; don't double-fail on fetch errors.
    }
  }

  if (failed.length > 0) {
    console.error(
      `\n❌ POST-DEPLOY VERIFICATION FAILED: ${failed.length} surface(s) broken on live.`
    );
    for (const f of failed) {
      console.error(`   - ${f.path}: HTTP ${f.status}${f.reason ? ` (${f.reason})` : ""}`);
    }
    console.error("   Redeploy after diagnosing dist/ + concurrent-build state.");
    process.exit(1);
  }
  console.log(`✅ Post-deploy verification passed.`);
}

// Post-deploy: ping IndexNow so Bing / Yandex / Seznam / Naver re-crawl.
if (!process.argv.includes("--skip-indexnow")) {
  console.log("\nPinging IndexNow…");
  const pingScript = new URL("scripts/indexnow-ping.ts", import.meta.url).pathname;
  const ping = await $`bun ${pingScript}`.nothrow();
  if (ping.exitCode !== 0) {
    console.error("⚠ IndexNow ping failed (deploy itself succeeded)");
  }
}
