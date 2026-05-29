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

console.log("");

if (!distOk) {
  await handleDivergence("dist/ is older than src/ — build may be stale.");
}

if (!liveOk) {
  await handleDivergence("Live deployment has tokens not in local dist/.");
}

if (distOk && liveOk) {
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
