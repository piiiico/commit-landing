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

  function extractObjectKeys(varName: string): Set<string> | null {
    // Find the declaration anchor, then walk braces forward until the
    // matching closing brace. Simple regex would mis-match nested objects.
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

  const refKeys = extractObjectKeys("REF_TO_SOURCE");
  const heroKeys = extractObjectKeys("HERO_BY_REF");
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
// GUARD 4: No crawler-followable /api/checkout in static HTML
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
const liveOk = await checkLiveTokens();
const heroOk = await checkHeroRefMapping();
const noStaticCheckoutOk = await checkNoStaticCheckoutLinks();

console.log("");

if (!distOk) {
  await handleDivergence("dist/ is older than src/ — build may be stale.");
}

if (!liveOk) {
  await handleDivergence("Live deployment has tokens not in local dist/.");
}

if (!heroOk) {
  await handleDivergence("REF_TO_SOURCE has refs without matching HERO_BY_REF entries (orphan promise).");
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

if (distOk && liveOk && heroOk && noStaticCheckoutOk) {
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

// Post-deploy: ping IndexNow so Bing / Yandex / Seznam / Naver re-crawl.
if (!process.argv.includes("--skip-indexnow")) {
  console.log("\nWaiting 10s for edge propagation, then pinging IndexNow…");
  await new Promise((r) => setTimeout(r, 10_000));
  const pingScript = new URL("scripts/indexnow-ping.ts", import.meta.url).pathname;
  const ping = await $`bun ${pingScript}`.nothrow();
  if (ping.exitCode !== 0) {
    console.error("⚠ IndexNow ping failed (deploy itself succeeded)");
  }
}
