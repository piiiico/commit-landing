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
 * AND (added 2026-06-13 second pass): for every ref that has a CUSTOM
 * HERO_BY_REF entry whose promise diverges from the generic web/REST
 * default, there MUST be a matching source-aware branch in:
 *   5. get-started.astro success-note (HOOK_SOURCES / MCP_SOURCES /
 *      CLI_SOURCES / CI_SOURCES / README_SOURCES) — so the success state
 *      after API-key creation echoes the hero promise instead of pivoting
 *      to generic "Authorization: Bearer" REST snippets.
 *   6. worker.ts welcome-email step 2 (HOOK_SOURCES_WELCOME /
 *      MCP_SOURCES_WELCOME / CI_SOURCES_WELCOME / README_SOURCES_WELCOME)
 *      — so the inbox follow-up keeps the same next-action frame the hero
 *      and success-note already committed to.
 * Refs whose HERO_BY_REF copy genuinely points at the REST/web flow (audit-
 * web*, etc.) are allowlisted in DEFAULT_OK_REFS.
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
 * 2026-06-13 (second pass): the README refs reached source attribution but
 * still hit the GENERIC default on success-note and welcome-email step 2,
 * pivoting the chain mid-flow from "score your tree" to "Authorization:
 * Bearer". Sites 5-6 added so the next custom-hero ref can't ship that
 * inconsistency unnoticed.
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
// 2026-06-15: utm_campaign=X arriving at /pricing — distinct emitter
// pattern from ?ref=X. The backend buildUpgradeUrl flow (worker.ts) and
// CLI upgrade prompts (npm-package/index.js) write URLs like
//   /pricing?email=...&utm_source=key&utm_campaign=key-upgrade
// pricing.astro CONTEXT_BY_CAMPAIGN reads utm_campaign and shows a
// surface-aware banner. If a campaign tag emits but isn\'t in the map,
// the banner stays silent and /pricing reads as a generic page to a
// visitor with maximum engagement context. This regressed 6× before
// this gate (audit-healthy-key 2026-06-10, ci-annotation 2026-06-12,
// free-watch-cmd + upgrade-from-free-key + status-limit + post-login +
// init + help all caught simultaneously 2026-06-15). Now caught at
// build time — every utm_campaign emitted toward /pricing in scanned
// surfaces must have a matching CONTEXT_BY_CAMPAIGN entry.
// Broad scan: any [?&]utm_campaign=X URL-parameter literal in scoped files.
// All utm_campaign usages in this codebase target /pricing — the buildUpgradeUrl
// helper (worker.ts:4622), the weekly digest URL (worker.ts:6715), and the
// CLI upgrade prompts (npm-package/index.js) — so we can scan flat instead of
// trying to bracket-match through template literal interpolations like
// `?email=${encodeURIComponent(row.email)}&utm_campaign=...` which the old
// /pricing[^...)...]/ pattern stopped at the first `)` and missed.
const priceCampaignRe = /[?&]utm_campaign=([a-zA-Z0-9_-]+)/g;

const getStartedRefs = new Set<string>();
const pricingRefs    = new Set<string>();
const pricingCampaigns = new Set<string>();

let m: RegExpExecArray | null;
// CLI runtime + both README discovery surfaces (npm + GH README) — pre-existing scope
for (const src of [npmSrc, npmReadmeSrc, ghReadmeSrc]) {
  gsRefRe.lastIndex = 0;
  priceRefRe.lastIndex = 0;
  while ((m = gsRefRe.exec(src)) !== null)    getStartedRefs.add(m[1]);
  while ((m = priceRefRe.exec(src)) !== null) pricingRefs.add(m[1]);
}

// 2026-06-15: buildWatchUrl(results, 'X') call sites — the URL is constructed
// inside the helper via template literal `…?ref=${ref}…`, so the literal
// `ref=cli-watch` never appears in the source text. The regex above
// (gsRefRe) misses these by design — it requires the URL string. v1.32.0
// shipped 'cli-watch' on 2026-06-15 05:14Z; this gate ran green an hour later
// because cli-watch was nowhere in the URL-literal scan, while the landing
// page had no HERO_BY_REF entry, no REF_TO_SOURCE entry, and no CLI_SOURCES
// membership. Real-money cost: the highest-intent CI/CRITICAL upsell audience
// landed on the generic "Get your API key" hero. Same class as audit-baseline
// (also passed via buildWatchUrl) — accidentally OK because its hero was hand-
// added earlier, not because the gate caught it. Scanning call sites closes
// the blind spot: every ref passed to buildWatchUrl is treated as a routing
// ref destined for /get-started, same gate requirements as URL-literal refs.
// Pattern is conservative: matches `buildWatchUrl(<anything-non-comma>,
// 'STRING')` and the trailing arg only — same arity buildWatchUrl actually
// has in npm-package/index.js. Extra args / refactors break loudly via
// unit tests + this gate flagging missing entries on the next run.
const buildWatchUrlRefRe = /buildWatchUrl\s*\([^,]+,\s*['"]([a-zA-Z0-9_-]+)['"]/g;
for (const src of [npmSrc]) {
  buildWatchUrlRefRe.lastIndex = 0;
  while ((m = buildWatchUrlRefRe.exec(src)) !== null) getStartedRefs.add(m[1]);
}

// utm_campaign scan adds worker.ts because server-side URL construction
// (buildUpgradeUrl, weekly digest email) emits utm_campaign directly to
// /pricing without going through CLI. README surfaces use ?ref= not
// utm_campaign so they\'re skipped here — refs are still covered by
// the ?ref= pass above. get-started.astro contributes its
// data-utm-campaign HTML attributes (post-signup upgrade buttons) and
// pricing.astro itself contributes the ref→utm_campaign promotion list
// — both sides should match what their downstream banner can render.
const paramSetRe = /params\.set\(\s*['"]utm_campaign['"]\s*,\s*['"]([a-zA-Z0-9_-]+)['"]\s*\)/g;
const dataAttrRe = /data-utm-campaign=['"]([a-zA-Z0-9_-]+)['"]/g;
for (const src of [npmSrc, workerSrc]) {
  priceCampaignRe.lastIndex = 0;
  while ((m = priceCampaignRe.exec(src)) !== null) pricingCampaigns.add(m[1]);
}
// params.set('utm_campaign', X) — backend buildUpgradeUrl pattern (worker.ts).
for (const src of [workerSrc]) {
  paramSetRe.lastIndex = 0;
  while ((m = paramSetRe.exec(src)) !== null) pricingCampaigns.add(m[1]);
}
// data-utm-campaign="X" — frontend buttons that POST to /api/checkout-intent
// (get-started.astro post-signup upgrade buttons).
for (const src of [gsSrc]) {
  dataAttrRe.lastIndex = 0;
  while ((m = dataAttrRe.exec(src)) !== null) pricingCampaigns.add(m[1]);
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

// utm_campaign coverage — every campaign emitted toward /pricing in
// worker.ts or npm-package/index.js must have a banner variant. Missing
// = silent banner on highest-intent surfaces. See 2026-06-15 fix for
// rationale; this check is the recurrence intercept.
for (const campaign of pricingCampaigns) {
  if (!inBlock(priceSrc, "CONTEXT_BY_CAMPAIGN", campaign))
    gaps.push(`MISSING: pricing.astro CONTEXT_BY_CAMPAIGN['${campaign}'] (utm_campaign emitted by worker.ts or npm-package/index.js)`);
}

for (const ref of allRefs) {
  if (!inValidSources(workerSrc, ref))
    gaps.push(`MISSING: worker.ts VALID_SOURCES["${ref}"]`);
}

// ── Site 5+6: chain consistency for custom-hero refs ─────────────────────────
// Refs that ARE custom-hero entries but legitimately map to the REST/web
// default (the hero copy itself promises Authorization: Bearer / API usage).
// All other custom-hero refs must appear in one of the downstream
// source-aware branches in success-note (get-started.astro) AND welcome-
// email step 2 (worker.ts) — else the chain pivots mid-flow.
const DEFAULT_OK_REFS = new Set<string>([
  "audit-web",
  "audit-web-429",
  "audit-web-critical",
  "audit-web-compromised",
  "audit-web-healthy",
]);

/** Branch-set names searched in success-note (get-started.astro) and welcome-email (worker.ts). */
const SUCCESS_NOTE_BRANCH_SETS = ["HOOK_SOURCES", "MCP_SOURCES", "CLI_SOURCES", "CI_SOURCES", "README_SOURCES"];
const WELCOME_BRANCH_SETS      = ["HOOK_SOURCES_WELCOME", "MCP_SOURCES_WELCOME", "CI_SOURCES_WELCOME", "README_SOURCES_WELCOME", "CLI_SOURCES_WELCOME"];

/** Check whether a source key appears inside any of the named Set literals in source text. */
function inAnySet(src: string, setNames: string[], key: string): boolean {
  for (const name of setNames) {
    // Each set is declared as `const NAME = new Set(['a', 'b', ...]);` — single line.
    const decl = new RegExp(`const\\s+${name}\\s*=\\s*new\\s+Set\\(\\[([^\\]]*)\\]\\)`, "m");
    const m = src.match(decl);
    if (!m) continue;
    const inner = m[1];
    if (inner.includes(`'${key}'`) || inner.includes(`"${key}"`)) return true;
  }
  return false;
}

// All custom-hero refs that aren't on the REST/web default allowlist.
for (const ref of getStartedRefs) {
  if (!inBlock(gsSrc, "HERO_BY_REF", ref)) continue; // already flagged by site 1
  if (DEFAULT_OK_REFS.has(ref)) continue;

  if (!inAnySet(gsSrc, SUCCESS_NOTE_BRANCH_SETS, ref))
    gaps.push(`MISSING: get-started.astro success-note branch for '${ref}' (add to one of ${SUCCESS_NOTE_BRANCH_SETS.join("/")}) — hero promises something other than REST/web; success-note will fall through to generic Authorization: Bearer.`);

  if (!inAnySet(workerSrc, WELCOME_BRANCH_SETS, ref))
    gaps.push(`MISSING: worker.ts welcome-email step 2 branch for '${ref}' (add to one of ${WELCOME_BRANCH_SETS.join("/")}) — hero promises something other than CI-gate onboarding; step 2 will fall through to generic "Add a CI gate" copy.`);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`Funnel surface parity check`);
console.log(`  npm-package refs → get-started: [${[...getStartedRefs].join(", ")}]`);
console.log(`  npm-package refs → pricing:     [${[...pricingRefs].join(", ")}]`);
console.log(`  worker+cli utm_campaign → pricing: [${[...pricingCampaigns].join(", ")}]`);
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
