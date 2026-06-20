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
 * 2026-06-20 (10th+ occurrence): orphan-campaign-from-astro-page. The
 * 06:30Z /scan/ Watch CTA + 07:21Z /pricing/ banner pair (same author,
 * same morning) shipped utm_campaign=watch-cta from src/pages/scan/index.astro
 * — and only the second commit added the CONTEXT_BY_CAMPAIGN variant. The
 * gate ran green throughout because it only scanned npm-package/index.js +
 * worker.ts + get-started.astro data-utm-campaign. Astro pages other than
 * blog (which has its own ref scan) and the gate sites themselves were
 * invisible. Today's dogfood also surfaced TWO LATENT orphans the gate
 * had silently allowed for weeks: github-audit-429 (audit.astro:2414,2421
 * — GitHub repo audit 429-rescue CTA, silent banner since 2026-06-01) and
 * staged-publishing-blog (blog/staged-publishing-detection.astro:162 —
 * staged-publishing pitch CTA, silent banner since publish). Extending
 * the scan to all src/pages/<not pricing,not get-started>.astro catches
 * the recurrence class at build time. CLAUDE.md skill→code escalation
 * triggered: pattern has recurred 10+ times since 2026-05-23; the gate
 * existed for 9 of those but didn't cover astro emitters; moving the
 * coverage to the default execution path makes bypass require explicit
 * opt-out (e.g. removing the glob), not accidental file-placement.
 *
 * SCOPE: literal URL strings in npm-package/index.js + README.md +
 *        npm-package/README.md + src/pages/<all non-gate-site>.astro. No
 *        AST parsing, no generalising beyond 4 gates.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = resolve(import.meta.dir, "../..");
const NPM_PKG   = join(ROOT, "proof-of-commitment/npm-package/index.js");
const NPM_README = join(ROOT, "proof-of-commitment/npm-package/README.md");
const GH_README  = join(ROOT, "proof-of-commitment/README.md");
const GET_STARTED = join(ROOT, "commit-landing-v2/src/pages/get-started.astro");
const PRICING   = join(ROOT, "commit-landing-v2/src/pages/pricing.astro");
const WORKER    = join(ROOT, "proof-of-commitment/src/backend/worker.ts");
const BLOG_DIR  = join(ROOT, "commit-landing-v2/src/pages/blog");
const PAGES_DIR = join(ROOT, "commit-landing-v2/src/pages");

// ── Read sources ─────────────────────────────────────────────────────────────
const npmSrc    = readFileSync(NPM_PKG, "utf8");
const npmReadmeSrc = readFileSync(NPM_README, "utf8");
const ghReadmeSrc  = readFileSync(GH_README, "utf8");
const gsSrc     = readFileSync(GET_STARTED, "utf8");
const priceSrc  = readFileSync(PRICING, "utf8");
const workerSrc = readFileSync(WORKER, "utf8");
// 2026-06-15: blog posts ship CTAs with ref=blog-<slug> attribution.
// The CLI-runtime scan above does not see them — they live in .astro
// files under src/pages/blog/. AUR-1579 hot-news post (deployed
// 2026-06-13 with CTAs backported 2026-06-15 01:00Z) shipped 5 blog-*
// refs that all leaked to the generic "Get your API key" hero because
// HERO_BY_REF only had blog-snyk-comparison. Pre-this-extension, the
// gate ran green because blog refs were nowhere in scanned sources.
const blogSrcs: { file: string; content: string }[] = [];
try {
  for (const file of readdirSync(BLOG_DIR)) {
    if (file.endsWith(".astro")) {
      blogSrcs.push({ file, content: readFileSync(join(BLOG_DIR, file), "utf8") });
    }
  }
} catch {
  // BLOG_DIR may not exist in some checkouts; gate degrades to pre-2026-06-15 scope.
}

// 2026-06-20: ALL non-gate-site astro pages under src/pages/ get scanned
// for utm_campaign emitters. Pricing.astro is excluded — it IS the
// CONTEXT_BY_CAMPAIGN home, and its utm_campaign mentions are exclusively
// in doc-comments (which would force comment text and CONTEXT_BY_CAMPAIGN
// keys to stay in sync — fragile). Get-started.astro is excluded for the
// same reason (it's the HERO_BY_REF / REF_TO_SOURCE / data-utm-campaign
// home and already scanned by dedicated logic above). Anything else under
// src/pages/ — scan/, audit.astro, dashboard.astro, blog/, compare/,
// companions/, forensics/, watchlist/, etc. — must surface its
// utm_campaign emitters through the CONTEXT_BY_CAMPAIGN gate or the
// banner stays silent on /pricing for the cohort arriving via that page.
function walkAstroFiles(dir: string): string[] {
  const found: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        found.push(...walkAstroFiles(full));
      } else if (entry.endsWith(".astro")) {
        found.push(full);
      }
    }
  } catch {
    // dir may not exist in some checkouts; degrade quietly.
  }
  return found;
}

const PAGE_SCAN_EXCLUDE = new Set<string>([
  join(PAGES_DIR, "pricing.astro"),     // CONTEXT_BY_CAMPAIGN home — its mentions are comments
  join(PAGES_DIR, "get-started.astro"), // dedicated data-utm-campaign scan above
]);
const pageSrcs: { file: string; content: string }[] = [];
for (const full of walkAstroFiles(PAGES_DIR)) {
  if (PAGE_SCAN_EXCLUDE.has(full)) continue;
  pageSrcs.push({ file: full, content: readFileSync(full, "utf8") });
}

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

// 2026-06-20: scan all non-gate-site astro pages (scan/, audit, dashboard,
// blog/, compare/, companions/, forensics/, watchlist/, etc.) for
// utm_campaign emitters. The morning's /scan/ Watch CTA orphan was the
// trigger; the same pass surfaced TWO latent orphans (github-audit-429 from
// audit.astro and staged-publishing-blog from blog/staged-publishing-detection.astro)
// the prior gate had silently allowed.
// We also collect a per-page index so the gap report can name the source
// file — useful when the same campaign string is correct on one page and
// missing on another, or when triaging "where did this campaign come from?".
const pageCampaignSources = new Map<string, Set<string>>(); // campaign → set of files
for (const { file, content } of pageSrcs) {
  priceCampaignRe.lastIndex = 0;
  while ((m = priceCampaignRe.exec(content)) !== null) {
    const campaign = m[1];
    pricingCampaigns.add(campaign);
    if (!pageCampaignSources.has(campaign)) pageCampaignSources.set(campaign, new Set());
    pageCampaignSources.get(campaign)!.add(file);
  }
}

// 2026-06-15: scan blog posts for ref=blog-<slug>. These refs are
// admitted by BLOG_REF_RE in worker.ts and get-started.astro
// form-submission code, AND covered by BLOG_HERO_FALLBACK in
// get-started.astro hero IIFE — so they do NOT need individual
// HERO_BY_REF / REF_TO_SOURCE / VALID_SOURCES entries. The gate's
// job for blog refs is to verify the fallback infrastructure
// (BLOG_HERO_FALLBACK + BLOG_REF_RE in both sides) still exists, not
// to require per-ref additions. Tracked separately so the per-ref
// loop below does not flag every blog post that ships a CTA.
const blogRefsEmitted = new Set<string>();
const blogPathRefRe = /\/get-started[^'"\s)<>]*[?&]ref=(blog-[a-z0-9-]{1,40})/g;
for (const { content } of blogSrcs) {
  blogPathRefRe.lastIndex = 0;
  while ((m = blogPathRefRe.exec(content)) !== null) blogRefsEmitted.add(m[1]);
}
// Blog refs the gate would otherwise per-ref check: split into those
// with custom HERO_BY_REF (route through pre-existing per-ref logic)
// and those relying on the fallback (require fallback infrastructure).
const blogRefsWithCustomHero = new Set<string>();
const blogRefsViaFallback = new Set<string>();
for (const ref of blogRefsEmitted) {
  if (inBlock(gsSrc, "HERO_BY_REF", ref)) blogRefsWithCustomHero.add(ref);
  else blogRefsViaFallback.add(ref);
}
// Per-ref loop below should only check blog refs with custom heroes;
// fallback-routed refs are checked via the single-fixture assertions
// at the bottom (BLOG_HERO_FALLBACK + BLOG_REF_RE on both sides).
const refsForPerRefLoop = new Set([...getStartedRefs, ...blogRefsWithCustomHero]);

const allRefs = new Set([...getStartedRefs, ...pricingRefs, ...blogRefsWithCustomHero]);

// ── Gate check helpers ───────────────────────────────────────────────────────
/** Check whether a quoted key appears in a named record literal in source. */
function inBlock(src: string, blockName: string, key: string): boolean {
  // 2026-06-20: prefer the `const ${blockName}` declaration position so
  // doc-comments referencing the block above its declaration (existing
  // pricing.astro pattern — comments at lines 867/1101/1160 reference
  // CONTEXT_BY_CAMPAIGN before the actual declaration at line 1019) do
  // not eat into the window. Pre-this-fix the first indexOf landed on
  // a comment, and additions to CONTEXT_BY_CAMPAIGN that pushed late
  // entries (welcome-upgrade, checkout-recovery) past 20k chars made
  // the parity check spuriously claim they were MISSING when they were
  // present but out-of-window. Mirrors the inValidSources anchor
  // (`const VALID_SOURCES`) pattern above for symmetry. Fall back to
  // bare indexOf for blocks declared without `const` if any are added
  // in the future.
  const declStart = src.indexOf(`const ${blockName}`);
  const blockStart = declStart !== -1 ? declStart : src.indexOf(`${blockName}`);
  if (blockStart === -1) return false;
  // 2026-06-20: window 20k → 30k. CONTEXT_BY_CAMPAIGN reached 22k chars
  // when the watch-cta variant + buildWatchCtaMsg helper landed; 30k
  // leaves ~8k headroom for the next variants without re-touching the
  // gate.
  const window = src.slice(blockStart, blockStart + 30_000);
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

for (const ref of refsForPerRefLoop) {
  if (!inBlock(gsSrc, "HERO_BY_REF", ref))
    gaps.push(`MISSING: get-started.astro HERO_BY_REF['${ref}']`);

  if (!inBlock(gsSrc, "REF_TO_SOURCE", ref))
    gaps.push(`MISSING: get-started.astro REF_TO_SOURCE['${ref}']`);
}

// 2026-06-15: Blog-ref fallback infrastructure check.
// When ANY blog-<slug> CTA is emitted from src/pages/blog/*.astro,
// the fallback chain must be intact end-to-end:
//   - get-started.astro hero IIFE has BLOG_HERO_FALLBACK
//   - get-started.astro form-submit IIFE has BLOG_REF_RE (REF_TO_SOURCE pass-through)
//   - worker.ts /api/keys/create has BLOG_REF_RE (VALID_SOURCES pass-through)
// Without these, blog refs silently fall through to "Get your API key"
// hero + source=web attribution. Single-fixture assertion covers all
// fallback-routed blog refs; per-ref checks above still catch refs that
// claim a CUSTOM hero entry but forget the matching success-note/welcome
// chain (e.g. blog-snyk-comparison).
if (blogRefsViaFallback.size > 0) {
  const blogList = [...blogRefsViaFallback].join(", ");
  if (!gsSrc.includes("BLOG_HERO_FALLBACK"))
    gaps.push(`MISSING: get-started.astro BLOG_HERO_FALLBACK — ${blogRefsViaFallback.size} blog ref(s) emitted via fallback (${blogList}) but hero IIFE has no fallback variant. Without it, all of them fall through to the generic "Get your API key" hero.`);
  if (!gsSrc.includes("BLOG_REF_RE"))
    gaps.push(`MISSING: get-started.astro BLOG_REF_RE — blog refs emitted (${blogList}) but form-submit code has no BLOG_REF_RE; REF_TO_SOURCE pass-through is dead and source attribution will be dropped to source=web.`);
  if (!workerSrc.includes("BLOG_REF_RE"))
    gaps.push(`MISSING: worker.ts BLOG_REF_RE — blog refs emitted (${blogList}) but /api/keys/create has no BLOG_REF_RE admission; backend will coerce source to "web".`);
}

// 2026-06-15: dev.to fallback infrastructure check — same shape as blog-*
// but the emitters are external to this repo (dev.to articles published via
// API). The first native article (devto-npm-audit, 2026-06-15 09:51Z) ships
// CTAs ?ref=devto-npm-audit; future syndication will reuse devto-<slug>.
// Since the gate can't scan dev.to itself, we treat the fallback infra as
// PERMANENT once any devto-* attribution has been wired in (i.e. once the
// fallback variants exist on either side, the gate insists they exist on
// BOTH sides). This is the smallest assertion that catches the orphan
// (one side updated, the other forgotten) without overreaching into "this
// must always exist" (we keep the option to remove dev.to syndication
// entirely by removing the fallback from both sides in one commit).
const gsHasDevto = gsSrc.includes("DEVTO_HERO_FALLBACK") || gsSrc.includes("DEVTO_REF_RE") || gsSrc.includes("DEVTO_SOURCE_RE");
const workerHasDevto = workerSrc.includes("DEVTO_REF_RE") || workerSrc.includes("DEVTO_SOURCE_RE");
if (gsHasDevto || workerHasDevto) {
  if (!gsSrc.includes("DEVTO_HERO_FALLBACK"))
    gaps.push(`MISSING: get-started.astro DEVTO_HERO_FALLBACK — devto-<slug> infra present elsewhere but hero IIFE has no fallback variant. Without it, dev.to article readers land on the generic "Get your API key" hero.`);
  if (!gsSrc.includes("DEVTO_REF_RE"))
    gaps.push(`MISSING: get-started.astro DEVTO_REF_RE — devto-<slug> infra present elsewhere but form-submit code has no DEVTO_REF_RE; source attribution will be dropped to source=web.`);
  if (!workerSrc.includes("DEVTO_REF_RE"))
    gaps.push(`MISSING: worker.ts DEVTO_REF_RE — devto-<slug> infra present elsewhere but /api/keys/create has no DEVTO_REF_RE admission; backend will coerce source to "web".`);
  if (!workerSrc.includes("DEVTO_SOURCE_RE"))
    gaps.push(`MISSING: worker.ts DEVTO_SOURCE_RE — devto-<slug> infra present on landing but welcome-email isDiscoverySource has no DEVTO_SOURCE_RE branch; step 2 falls through to "Add a CI gate" copy that contradicts the discovery-pitch hero.`);
  if (!gsSrc.includes("DEVTO_SOURCE_RE"))
    gaps.push(`MISSING: get-started.astro DEVTO_SOURCE_RE — devto-<slug> infra present elsewhere but landing success-note isDiscoverySource has no DEVTO_SOURCE_RE branch; success-note pivots to "Authorization: Bearer" mid-flow.`);
}

// 2026-06-15: outreach-<slug> fallback infrastructure check — same shape as
// devto-* but the emitters are cold-email bodies sent from commit@getcommit.dev
// (Convex E1 ref=outreach-convex shipped 11:15Z today; e2b E1 ref=outreach-e2b
// shipped 07:12Z). Email bodies live in send-email.ts task descriptions /
// drafts, not in this repo — the gate cannot scan them. Same approach as
// DEVTO: once OUTREACH infra is wired in on either side, the gate insists
// both sides stay in sync. Removing outreach attribution would require
// removing the fallback from both sides in one commit (intentional).
// 9th occurrence of "new ref symbol ships, downstream gates do not know
// about it" pattern (after ci-annotation 06-12, readme + npm-readme 06-13,
// cli-watch 06-15 05:48Z, blog-fallback 06-15 06:20Z, devto-fallback 06-15
// 10:23Z, welcome-upgrade campaign 06-15 10:50Z). Pattern admit subtracts
// per-recipient additions forever.
const gsHasOutreach = gsSrc.includes("OUTREACH_HERO_FALLBACK") || gsSrc.includes("OUTREACH_REF_RE") || gsSrc.includes("OUTREACH_SOURCE_RE");
const workerHasOutreach = workerSrc.includes("OUTREACH_REF_RE") || workerSrc.includes("OUTREACH_SOURCE_RE");
if (gsHasOutreach || workerHasOutreach) {
  if (!gsSrc.includes("OUTREACH_HERO_FALLBACK"))
    gaps.push(`MISSING: get-started.astro OUTREACH_HERO_FALLBACK — outreach-<slug> infra present elsewhere but hero IIFE has no fallback variant. Without it, cold-outreach recipients land on the generic "Get your API key" hero after clicking through an email that named specific packages.`);
  if (!gsSrc.includes("OUTREACH_REF_RE"))
    gaps.push(`MISSING: get-started.astro OUTREACH_REF_RE — outreach-<slug> infra present elsewhere but form-submit code has no OUTREACH_REF_RE; source attribution will be dropped to source=web on every cold-outreach click-through.`);
  if (!workerSrc.includes("OUTREACH_REF_RE"))
    gaps.push(`MISSING: worker.ts OUTREACH_REF_RE — outreach-<slug> infra present elsewhere but /api/keys/create has no OUTREACH_REF_RE admission; backend will coerce source to "web".`);
  if (!workerSrc.includes("OUTREACH_SOURCE_RE"))
    gaps.push(`MISSING: worker.ts OUTREACH_SOURCE_RE — outreach-<slug> infra present on landing but welcome-email isDiscoverySource has no OUTREACH_SOURCE_RE branch; step 2 falls through to "Add a CI gate" copy that contradicts the cold-outreach hero.`);
  if (!gsSrc.includes("OUTREACH_SOURCE_RE"))
    gaps.push(`MISSING: get-started.astro OUTREACH_SOURCE_RE — outreach-<slug> infra present elsewhere but landing success-note isDiscoverySource has no OUTREACH_SOURCE_RE branch; success-note pivots to "Authorization: Bearer" mid-flow.`);
}

for (const ref of pricingRefs) {
  if (!inBlock(priceSrc, "CONTEXT_BY_CAMPAIGN", ref))
    gaps.push(`MISSING: pricing.astro CONTEXT_BY_CAMPAIGN['${ref}']`);
}

// utm_campaign coverage — every campaign emitted toward /pricing in
// worker.ts, npm-package/index.js, get-started.astro data-utm-campaign,
// OR any non-gate-site src/pages/<page>.astro must have a banner variant.
// Missing = silent banner on highest-intent surfaces. See 2026-06-15 fix
// (orphan-banner class 9) and 2026-06-20 extension (orphan-banner class 10:
// astro pages) for rationale; this check is the recurrence intercept.
for (const campaign of pricingCampaigns) {
  if (!inBlock(priceSrc, "CONTEXT_BY_CAMPAIGN", campaign)) {
    const astroSources = pageCampaignSources.get(campaign);
    const src = astroSources
      ? `astro page(s) ${[...astroSources].map((f) => f.replace(ROOT + "/", "")).join(", ")}`
      : `worker.ts, npm-package/index.js, or get-started.astro data-utm-campaign`;
    gaps.push(`MISSING: pricing.astro CONTEXT_BY_CAMPAIGN['${campaign}'] (utm_campaign emitted by ${src})`);
  }
}

for (const ref of allRefs) {
  // blog-<slug> refs are admitted by BLOG_REF_RE in worker.ts /api/keys/create
  // (verified above by the blog-fallback infrastructure check). Skip per-ref
  // VALID_SOURCES check for them — pre-existing blog-snyk-comparison (custom
  // hero) passes through BLOG_REF_RE same as fallback-routed blog refs.
  if (/^blog-[a-z0-9-]{1,40}$/.test(ref)) continue;
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
console.log(`  npm-package refs → get-started:   [${[...getStartedRefs].join(", ")}]`);
console.log(`  npm-package refs → pricing:       [${[...pricingRefs].join(", ")}]`);
console.log(`  worker+cli+pages utm_campaign → pricing: [${[...pricingCampaigns].join(", ")}]`);
if (pageCampaignSources.size > 0) {
  console.log(`  astro page utm_campaign emitters:`);
  for (const [campaign, files] of pageCampaignSources) {
    const fileNames = [...files].map((f) => f.replace(ROOT + "/", "")).join(", ");
    console.log(`    ${campaign} ← ${fileNames}`);
  }
}
console.log(`  blog → get-started (custom hero): [${[...blogRefsWithCustomHero].join(", ")}]`);
console.log(`  blog → get-started (fallback):    [${[...blogRefsViaFallback].join(", ")}]`);
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
