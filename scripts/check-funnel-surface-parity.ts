#!/usr/bin/env bun
/**
 * check-funnel-surface-parity.ts
 *
 * Build-time gate: asserts every ref=X URL emitted by proof-of-commitment
 * runtime AND static-doc surfaces has matching entries in all 4 gate sites:
 *   1. get-started.astro HERO_BY_REF
 *   2. get-started.astro REF_TO_SOURCE
 *   3. pricing.astro CONTEXT_BY_CAMPAIGN
 *   4. proof-of-commitment worker.ts VALID_SOURCES
 *
 * Exit 0 = full parity. Exit 1 = gap found (printed to stderr).
 *
 * Pattern history: funnel-surface-gap recurred 5× in 3 weeks
 * (2026-05-23, 06-10 ×3, 06-12) without a build-time intercept.
 * This script is that intercept.
 *
 * 2026-06-13: extended SCOPE to scan README.md + npm-package/README.md after
 * the v1.31.1 README ship (visible CRITICAL demo) was found unmeasurable —
 * both README CTAs used refs (?ref=readme-monitoring / npm-readme-monitoring)
 * that fell through all 4 gates → source=web. The same funnel-surface-gap
 * pattern, just on a discovery surface the gate didn't watch. Adding the
 * READMEs to scanned sources catches the next variant before deploy.
 *
 * SCOPE: literal URL strings in npm-package/index.js + README.md +
 *        npm-package/README.md. No AST parsing, no generalising beyond 4 gates.
 */

import { readFileSync } from "fs";
import { join, resolve } from "path";

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = resolve(import.meta.dir, "../..");
const NPM_PKG   = join(ROOT, "proof-of-commitment/npm-package/index.js");
const NPM_README = join(ROOT, "proof-of-commitment/npm-package/README.md");
const GH_README  = join(ROOT, "proof-of-commitment/README.md");
const GET_STARTED = join(ROOT, "commit-landing-v2/src/pages/get-started.astro");
const PRICING   = join(ROOT, "commit-landing-v2/src/pages/pricing.astro");
const WORKER    = join(ROOT, "proof-of-commitment/src/backend/worker.ts");

// ── Read sources ─────────────────────────────────────────────────────────────
const npmSrc    = readFileSync(NPM_PKG, "utf8");
const npmReadmeSrc = readFileSync(NPM_README, "utf8");
const ghReadmeSrc  = readFileSync(GH_README, "utf8");
const gsSrc     = readFileSync(GET_STARTED, "utf8");
const priceSrc  = readFileSync(PRICING, "utf8");
const workerSrc = readFileSync(WORKER, "utf8");

// ── Extract refs from emitter surfaces ───────────────────────────────────────
// Refs that route to /get-started?ref=X (URLs may end at quote, paren, space, '#', '<')
const gsRefRe  = /getcommit\.dev\/get-started[^'")\s<>]*[?&]ref=([a-zA-Z0-9_-]+)/g;
// Refs that route to /pricing?ref=X
const priceRefRe = /getcommit\.dev\/pricing[^'")\s<>]*[?&]ref=([a-zA-Z0-9_-]+)/g;

const getStartedRefs = new Set<string>();
const pricingRefs    = new Set<string>();

let m: RegExpExecArray | null;
// CLI runtime + both README discovery surfaces (npm + GH README)
for (const src of [npmSrc, npmReadmeSrc, ghReadmeSrc]) {
  gsRefRe.lastIndex = 0;
  priceRefRe.lastIndex = 0;
  while ((m = gsRefRe.exec(src)) !== null)    getStartedRefs.add(m[1]);
  while ((m = priceRefRe.exec(src)) !== null) pricingRefs.add(m[1]);
}

const allRefs = new Set([...getStartedRefs, ...pricingRefs]);

// ── Gate check helpers ───────────────────────────────────────────────────────
/** Check whether a quoted key appears in a named record literal in source. */
function inBlock(src: string, blockName: string, key: string): boolean {
  // Find the block by name, then look for the quoted key within it.
  const blockStart = src.indexOf(`${blockName}`);
  if (blockStart === -1) return false;
  // Scan forward until we find a balanced closing brace for the block.
  // Simple heuristic: look for the key within 20k chars of the block start.
  const window = src.slice(blockStart, blockStart + 20_000);
  // Accept both single and double quotes.
  return window.includes(`'${key}'`) || window.includes(`"${key}"`);
}

/** Check whether a value appears in the VALID_SOURCES array literal. */
function inValidSources(src: string, key: string): boolean {
  // Look for the actual const declaration (not comments mentioning it)
  const arrStart = src.indexOf("const VALID_SOURCES");
  if (arrStart === -1) return false;
  // The array is a single-line literal — 3000 chars is plenty
  const window = src.slice(arrStart, arrStart + 3_000);
  return window.includes(`"${key}"`) || window.includes(`'${key}'`);
}

// ── Run checks ───────────────────────────────────────────────────────────────
const gaps: string[] = [];

for (const ref of getStartedRefs) {
  if (!inBlock(gsSrc, "HERO_BY_REF", ref))
    gaps.push(`MISSING: get-started.astro HERO_BY_REF['${ref}']`);

  if (!inBlock(gsSrc, "REF_TO_SOURCE", ref))
    gaps.push(`MISSING: get-started.astro REF_TO_SOURCE['${ref}']`);
}

for (const ref of pricingRefs) {
  if (!inBlock(priceSrc, "CONTEXT_BY_CAMPAIGN", ref))
    gaps.push(`MISSING: pricing.astro CONTEXT_BY_CAMPAIGN['${ref}']`);
}

for (const ref of allRefs) {
  if (!inValidSources(workerSrc, ref))
    gaps.push(`MISSING: worker.ts VALID_SOURCES["${ref}"]`);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`Funnel surface parity check`);
console.log(`  npm-package refs → get-started: [${[...getStartedRefs].join(", ")}]`);
console.log(`  npm-package refs → pricing:     [${[...pricingRefs].join(", ")}]`);
console.log();

if (gaps.length === 0) {
  console.log("✓ All refs in parity across 4 gate sites.");
  process.exit(0);
} else {
  console.error(`✗ ${gaps.length} parity gap${gaps.length > 1 ? "s" : ""} found:`);
  for (const g of gaps) console.error(`  ${g}`);
  console.error();
  console.error("Fix: add the missing entry to each gate site listed above.");
  console.error("See scripts/check-funnel-surface-parity.ts for the 4 gate sites.");
  process.exit(1);
}
