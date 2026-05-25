// SOURCE OF TRUTH for getcommit.dev runtime.
// Cloudflare Pages runs this as the worker in Advanced Mode.
// Edit HERE. `astro build` copies to dist/_worker.js; `deploy.ts` ships dist/.
// Do NOT edit dist/_worker.js directly — it is a build artifact, overwritten on next build.

/**
 * Cloudflare Pages Worker (_worker.js)
 *
 * Handles all requests for getcommit.dev:
 * - /npm/:pkg            → SSR package profile page (SEO-indexable)
 * - /pypi/:pkg           → SSR PyPI package profile page
 * - /cargo/:pkg          → SSR Cargo crate profile page
 * - /go/:module          → SSR Go module profile page (module path may include slashes)
 * - /scan/:pkg (crawler) → OG-enriched HTML for social crawlers
 * - /scan/:pkg (browser) → 302 redirect to /scan/?pkg=:pkg (SPA)
 * - Everything else      → serve from static assets (env.ASSETS)
 *
 * When _worker.js is present, CF Pages does NOT process _redirects.
 * All routing is handled here.
 */

const CRAWLER_UAS = [
  "facebookexternalhit",
  "twitterbot",
  "twittercard",
  "linkedinbot",
  "slackbot",
  "discordbot",
  "whatsapp",
  "telegrambot",
  "applebot",
  "googlebot",
  "bingbot",
  "pinterest",
  "embedly",
  "outbrain",
  "quora link preview",
  "showyoubot",
  "skypeuripreview",
  "vkshare",
  "w3c_validator",
  "redditbot",
  "tumblr",
  "bufferbot",
  "iframely",
  "rogerbot",
  "mattermost",
];

const API_BASE = "https://poc-backend.amdal-dev.workers.dev";

// GENERATED-EDIT-OK: public/_worker.js IS the source of truth per its own header — fixing SSR 502 rate-limit bypass
// Build headers for backend API calls. Includes X-SSR-Token when SSR_TOKEN
// env var is set — this bypasses the per-IP rate limit on /api/audit so
// package profile pages (/npm/:pkg etc.) don't 502 on busy days.
function ssrHeaders(env) {
  const h = { "Content-Type": "application/json" };
  if (env?.SSR_TOKEN) h["X-SSR-Token"] = env.SSR_TOKEN;
  return h;
}

function isCrawler(ua) {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return CRAWLER_UAS.some((bot) => lower.includes(bot));
}

function scoreToGrade(score) {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

function scoreToLabel(score, riskFlags) {
  if (riskFlags.includes("CRITICAL")) return "CRITICAL risk";
  if (riskFlags.includes("HIGH")) return "High risk";
  if (score >= 80) return "Healthy";
  if (score >= 60) return "Moderate";
  if (score >= 40) return "Elevated risk";
  return "High risk";
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Ecosystem configuration ──────────────────────────────────────────

const ECOSYSTEM_CONFIG = {
  npm: {
    eyebrow: "npm package trust score",
    publisherLabel: "npm publishers",
    registryUrl: (pkg) => `https://www.npmjs.com/package/${encodeURIComponent(pkg)}`,
    cliCmd: (pkg) => `npx proof-of-commitment ${pkg}`,
    siteName: "npm",
    schemaType: "SoftwareApplication",
  },
  pypi: {
    eyebrow: "PyPI package trust score",
    publisherLabel: "PyPI owners",
    registryUrl: (pkg) => `https://pypi.org/project/${encodeURIComponent(pkg)}/`,
    cliCmd: (pkg) => `npx proof-of-commitment --pypi ${pkg}`,
    siteName: "PyPI",
    schemaType: "SoftwareApplication",
  },
  cargo: {
    eyebrow: "Cargo crate trust score",
    publisherLabel: "crate owners",
    registryUrl: (pkg) => `https://crates.io/crates/${encodeURIComponent(pkg)}`,
    cliCmd: (pkg) => `npx proof-of-commitment --cargo ${pkg}`,
    siteName: "crates.io",
    schemaType: "SoftwareApplication",
  },
  go: {
    eyebrow: "Go module trust score",
    publisherLabel: "contributors",
    registryUrl: (pkg) => `https://pkg.go.dev/${pkg}`,
    cliCmd: (pkg) => `npx proof-of-commitment --go ${pkg}`,
    siteName: "pkg.go.dev",
    schemaType: "SoftwareApplication",
  },
};

// ── Related articles mapping ────────────────────────────────────────

// GENERATED-EDIT-OK: source-of-truth file — adding node-ipc + tanstack related articles for two-attacks post
const PACKAGE_ARTICLES = {
  // npm packages with dedicated articles
  "node-ipc": { slug: "two-attacks-one-week", title: "node-ipc Had a 69 Trust Score Before It Got Hacked. TanStack Had 91." },
  "hono": { slug: "hono-critical", title: "Hono Has 35M Weekly Downloads and One npm Publisher" },
  "axios": { slug: "the-axios-signal", title: "Why I Think axios Is the Next Supply Chain Attack Target" },
  "chalk": { slug: "invisible-critical-packages", title: "The Critical Packages Hiding in Your Lock File" },
  "zod": { slug: "invisible-critical-packages", title: "The Critical Packages Hiding in Your Lock File" },
  "express": { slug: "express-supply-chain", title: "Express Has 5 npm Publishers. Most Frameworks Have 1." },
  "openai": { slug: "ai-sdk-supply-chain-ranking", title: "I Ranked AI SDKs by Supply Chain Risk. LangChain Lost." },
  "@anthropic-ai/sdk": { slug: "ai-sdk-supply-chain-ranking", title: "I Ranked AI SDKs by Supply Chain Risk. LangChain Lost." },
  "vite": { slug: "transitive-risk-methodology", title: "npm audit ships yesterday's risk. Here's how to measure tomorrow's." },
  "webpack": { slug: "transitive-risk-methodology", title: "npm audit ships yesterday's risk. Here's how to measure tomorrow's." },
  "next": { slug: "transitive-risk-methodology", title: "npm audit ships yesterday's risk. Here's how to measure tomorrow's." },
  "once": { slug: "transitive-risk-methodology", title: "npm audit ships yesterday's risk. Here's how to measure tomorrow's." },
  "wrappy": { slug: "transitive-risk-methodology", title: "npm audit ships yesterday's risk. Here's how to measure tomorrow's." },
  "depd": { slug: "transitive-risk-methodology", title: "npm audit ships yesterday's risk. Here's how to measure tomorrow's." },
  "escape-html": { slug: "transitive-risk-methodology", title: "npm audit ships yesterday's risk. Here's how to measure tomorrow's." },
  "@tanstack/react-router": { slug: "tanstack-mini-shai-hulud-behavioral-analysis", title: "Mini Shai-Hulud Didn't Need Your Maintainer's Password" },
  "@tanstack/react-query": { slug: "tanstack-mini-shai-hulud-behavioral-analysis", title: "Mini Shai-Hulud Didn't Need Your Maintainer's Password" },
  "@tanstack/router": { slug: "tanstack-mini-shai-hulud-behavioral-analysis", title: "Mini Shai-Hulud Didn't Need Your Maintainer's Password" },
};

const ECOSYSTEM_ARTICLES = {
  npm: [
    { slug: "tanstack-mini-shai-hulud-behavioral-analysis", title: "Mini Shai-Hulud Didn't Need Your Maintainer's Password" },
    { slug: "trusted-publishing-adoption", title: "Half of npm's Top Packages Don't Use Trusted Publishing" },
    { slug: "npm-audit-zero-vulnerabilities", title: "Why npm audit Returns Zero Vulnerabilities for the Most Dangerous Packages" },
    { slug: "scoring-methodology", title: "How the Commit Scoring Algorithm Works" },
  ],
  pypi: [
    { slug: "python-supply-chain-risk", title: "certifi Has 350M Weekly Downloads and One Publisher" },
    { slug: "scoring-methodology", title: "How the Commit Scoring Algorithm Works" },
  ],
  cargo: [
    { slug: "cargo-supply-chain-risk", title: "serde Has 13M Weekly Downloads and One Crate Owner" },
    { slug: "scoring-methodology", title: "How the Commit Scoring Algorithm Works" },
  ],
  golang: [
    { slug: "go-supply-chain-different-risk", title: "I Scanned 20 Top Go Modules. Zero Scored CRITICAL." },
    { slug: "scoring-methodology", title: "How the Commit Scoring Algorithm Works" },
  ],
};

function getRelatedArticlesHtml(ecosystem, pkg) {
  const articles = [];
  const specific = PACKAGE_ARTICLES[pkg];
  if (specific) articles.push(specific);
  const ecoArticles = ECOSYSTEM_ARTICLES[ecosystem] || ECOSYSTEM_ARTICLES.npm;
  for (const a of ecoArticles) {
    if (!articles.find(x => x.slug === a.slug)) articles.push(a);
    if (articles.length >= 3) break;
  }
  if (articles.length === 0) return "";
  return `<section class="section"><div class="container">
<h2 class="section-title">Related reading</h2>
<ul style="margin:0;padding:0;list-style:none">${articles.map(a =>
  `<li style="margin-bottom:.75rem"><a href="/blog/${a.slug}" style="color:#D14D41;text-decoration:none;font-size:.95rem">${esc(a.title)}</a></li>`
).join("")}</ul>
</div></section>`;
}

// ── /npm/:pkg SSR page helpers ──────────────────────────────────────

function riskLabel(score, riskFlags) {
  const flags = riskFlags || [];
  if (flags.some((f) => f.includes("CRITICAL"))) return "CRITICAL";
  if (flags.some((f) => f.includes("HIGH"))) return "HIGH";
  if (flags.some((f) => f.includes("WARN"))) return "WARNING";
  if (score >= 80) return "SAFE";
  if (score >= 60) return "MODERATE";
  return "ELEVATED";
}

function riskColor(label) {
  switch (label) {
    case "CRITICAL": return "#D14D41";
    case "HIGH": return "#DA702C";
    case "WARNING": return "#D0A215";
    case "SAFE": return "#879A39";
    default: return "#878580";
  }
}

function formatDownloads(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
}

function renderBreakdownBar(label, value, max) {
  const pct = Math.round((value / max) * 100);
  const cls = pct >= 60 ? "bar-ok" : pct >= 35 ? "bar-warn" : "bar-low";
  return `<div class="bd-row"><span class="bd-label">${esc(label)}</span><div class="bd-track"><div class="bd-fill ${cls}" style="width:${pct}%"></div></div><span class="bd-val">${value}<span class="bd-max">/${max}</span></span></div>`;
}

// GENERATED-EDIT-OK: public/_worker.js IS the source of truth per its own header — fixing wrong-tier bait (Pro $29 → Developer $15 cheapest-paid with monitoring), aligns SEO pkg-profile surface with worker.ts TIER_LIMITS canonical truth (recurring class: tier-name divergence)
function buildMonitorCta(pkg, ecosystem, isCritical) {
  const headline = isCritical ? "Monitor this package" : "Track this package";
  const body = isCritical
    ? `<strong>${esc(pkg)}</strong> has concentrated publish-access risk. Get alerted when its publisher count, release cadence, or risk score changes.`
    : `Monitor <strong>${esc(pkg)}</strong> in CI. Catch risk changes before they reach production.`;
  // Package-specific CTA with source attribution. ?ref=pkg-profile lets the
  // get-started page split package-profile-driven signups from default 'web'
  // signups in the funnel; ?pkg=… &eco=… surface the in-context package on
  // the destination. Backend whitelists 'pkg-profile' in VALID_SOURCES.
  const ctaHref = `/get-started?ref=pkg-profile&pkg=${encodeURIComponent(pkg)}&eco=${encodeURIComponent(ecosystem)}`;
  const ctaText = isCritical
    ? `Get alerts for ${esc(pkg)} &rarr;`
    : `Track ${esc(pkg)} &rarr;`;
  return `<section class="section"><div class="container">
<div style="background:#F2F0E5;border:1px solid #CECDC3;border-radius:6px;padding:2rem">
<h2 style="font-family:'Instrument Serif',Georgia,serif;font-size:1.5rem;margin-bottom:.75rem">${headline}</h2>
<p class="context-note">${body}</p>
<div class="cta-row" style="margin:1.5rem 0 .5rem">
<a href="${ctaHref}" class="btn btn-primary">${ctaText}</a>
<a href="/pricing" class="btn btn-ghost">Compare plans &rarr;</a>
</div>
<!-- GENERATED-EDIT-OK: tier-name bait fix per /pricing canonical — Developer $15 is cheapest-paid w/ monitoring + batch -->
<p style="font-size:.82rem;color:#878580;margin:0">Free: 200 audits/day &middot; Paid from Developer ($15/mo): monitoring, batch API, email alerts</p>
</div></div></section>`;
}

function buildNpmPage(pkg, r, depth2Summary) {
  const score = r.score;
  const grade = scoreToGrade(score);
  const risk = riskLabel(score, r.riskFlags);
  const color = riskColor(risk);
  const dl = formatDownloads(r.weeklyDownloads || 0);
  const age = r.ageYears ? r.ageYears.toFixed(1) : "—";
  const maintainers = r.maintainers ?? "—";
  const ghContrib = r.githubContributors ?? null;
  const provenance = r.hasProvenance ? "Yes" : "No";
  const scorecard = r.scorecardScore != null ? r.scorecardScore.toFixed(1) + "/10" : "—";
  const bd = r.scoreBreakdown || {};
  const trustedPub = bd.trustedPublishing != null && bd.trustedPublishing > 0;
  const isCritical = risk === "CRITICAL";

  const title = `${pkg} npm trust score: ${score}/100 — Commit`;
  const description = isCritical
    ? `${pkg} scores ${score}/100 on supply chain trust. CRITICAL: sole npm publisher with ${dl} weekly downloads. Behavioral commitment analysis by Commit.`
    : `${pkg} scores ${score}/100 on supply chain trust (Grade ${grade}). ${maintainers} publisher${maintainers !== 1 ? "s" : ""}, ${dl} weekly downloads. Behavioral commitment analysis.`;

  const ogImage = `${API_BASE}/og/npm/${encodeURIComponent(pkg)}`;
  const canonical = `https://getcommit.dev/npm/${encodeURIComponent(pkg)}`;
  const badgeUrl = `${API_BASE}/badge/npm/${encodeURIComponent(pkg)}`;

  const breakdownDims = [
    { key: "longevity", label: "Longevity", max: 25 },
    { key: "downloadMomentum", label: "Download momentum", max: 25 },
    { key: "releaseConsistency", label: "Release consistency", max: 20 },
    { key: "maintainerDepth", label: "Publisher depth", max: 15 },
    { key: "githubBacking", label: "GitHub backing", max: 15 },
    { key: "trustedPublishing", label: "Trusted Publishing", max: 2 },
  ];
  const breakdownHtml = breakdownDims.filter((d) => bd[d.key] != null).map((d) => renderBreakdownBar(d.label, bd[d.key], d.max)).join("");

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: pkg,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    aggregateRating: { "@type": "AggregateRating", ratingValue: score, bestRating: 100, worstRating: 0, ratingCount: 1, reviewCount: 1 },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    url: `https://www.npmjs.com/package/${encodeURIComponent(pkg)}`,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:type" content="website"/><meta property="og:url" content="${canonical}"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>
<meta property="og:image" content="${ogImage}"/><meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/>
<meta property="og:site_name" content="Commit"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(description)}"/><meta name="twitter:image" content="${ogImage}"/>
<meta name="theme-color" content="#FFFCF0"/>
<script type="application/ld+json">${jsonLd}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500&display=swap" rel="stylesheet"/>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"79939812e2a340758ca8cc1ded073a22"}'></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px;scroll-behavior:smooth}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;font-weight:300;font-size:1rem;line-height:1.7;color:#1C1B1A;background:#FFFCF0;min-height:100vh}
a{color:#D14D41;text-decoration:none}a:hover{text-decoration:underline}
code{font-family:'JetBrains Mono','Fira Code',monospace;font-size:.85em;background:#F2F0E5;border:1px solid #CECDC3;border-radius:3px;padding:.1em .35em}
.container{max-width:48rem;margin:0 auto;padding:0 1.5rem}
nav{padding:1rem 0;border-bottom:1px solid #CECDC3}
.nav-inner{display:flex;align-items:center;justify-content:space-between;max-width:64rem;margin:0 auto;padding:0 1.5rem}
.nav-brand{font-family:'Instrument Serif',Georgia,serif;font-size:1.4rem;color:#1C1B1A;text-decoration:none}
.nav-links{list-style:none;display:flex;gap:1.5rem;font-size:.85rem}.nav-links a{color:#575653;text-decoration:none}.nav-links a:hover{color:#1C1B1A}
.hero{padding:4rem 0 3rem}
.hero-eyebrow{font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;color:#878580}
.pkg-name{font-family:'JetBrains Mono',monospace;font-size:clamp(1.8rem,4vw,2.8rem);font-weight:400;margin:.5rem 0 .25rem;word-break:break-all}
.pkg-eco{font-size:.9rem;color:#878580;margin-bottom:1.5rem}
.score-card{display:grid;grid-template-columns:auto 1fr;gap:2.5rem;align-items:start;margin-bottom:3rem}
@media(max-width:600px){.score-card{grid-template-columns:1fr}}
.score-ring{width:140px;height:140px;border-radius:50%;border:5px solid ${color};display:flex;flex-direction:column;align-items:center;justify-content:center}
.score-num{font-family:'Instrument Serif',Georgia,serif;font-size:3rem;line-height:1;color:#1C1B1A}
.score-of{font-size:.75rem;color:#878580}
.score-grade{display:inline-block;margin-top:.75rem;padding:.2rem .75rem;font-size:.8rem;font-weight:500;letter-spacing:.05em;border-radius:3px;background:${color}15;color:${color};border:1px solid ${color}40}
.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem 2rem}
@media(max-width:600px){.meta-grid{grid-template-columns:1fr}}
.meta-item{display:flex;flex-direction:column}.meta-label{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#878580}.meta-value{font-size:1.1rem;font-weight:400}
.section{padding:2.5rem 0;border-top:1px solid #CECDC3}
.section-title{font-family:'Instrument Serif',Georgia,serif;font-size:1.5rem;margin-bottom:1.25rem}
.bd-row{display:grid;grid-template-columns:10rem 1fr 3.5rem;gap:.75rem;align-items:center;margin-bottom:.6rem}
@media(max-width:600px){.bd-row{grid-template-columns:7rem 1fr 3rem;gap:.5rem}}
.bd-label{font-size:.85rem;color:#575653}.bd-track{height:8px;background:#E6E4D9;border-radius:4px;overflow:hidden}
.bd-fill{height:100%;border-radius:4px}.bd-fill.bar-ok{background:#879A39}.bd-fill.bar-warn{background:#D0A215}.bd-fill.bar-low{background:#D14D41}
.bd-val{font-family:'JetBrains Mono',monospace;font-size:.8rem;color:#575653;text-align:right}.bd-max{color:#878580}
.risk-flag{display:inline-block;padding:.3rem .8rem;font-size:.8rem;font-weight:500;border-radius:3px;margin-right:.5rem;margin-bottom:.5rem}
.risk-CRITICAL{background:#D14D4118;color:#AF3029;border:1px solid #D14D4140}
.risk-HIGH{background:#DA702C18;color:#BC5215;border:1px solid #DA702C40}
.risk-WARN{background:#D0A21518;color:#AD8301;border:1px solid #D0A21540}
.cta-row{display:flex;flex-wrap:wrap;gap:1rem;margin:2rem 0}
.btn{display:inline-block;padding:.65rem 1.5rem;border-radius:4px;font-size:.9rem;font-weight:500;text-decoration:none}
.btn-primary{background:#D14D41;color:#fff}.btn-primary:hover{background:#AF3029;text-decoration:none}
.btn-ghost{background:transparent;color:#1C1B1A;border:1px solid #CECDC3}.btn-ghost:hover{border-color:#1C1B1A;text-decoration:none}
.badge-section code{display:block;padding:.75rem 1rem;overflow-x:auto;white-space:pre;font-size:.82rem}
.context-note{font-size:.95rem;line-height:1.7;color:#575653}.context-note strong{color:#1C1B1A;font-weight:500}
footer{padding:3rem 0;border-top:1px solid #CECDC3;margin-top:3rem}footer p{font-size:.8rem;color:#878580}footer a{color:#878580}
</style>
</head>
<body>
<nav><div class="nav-inner"><a href="/" class="nav-brand">Commit</a><ul class="nav-links"><li><a href="/quickstart">Quickstart</a></li><li><a href="/audit">Audit</a></li><li><a href="/rankings">Rankings</a></li><li><a href="/blog">Writing</a></li><li><a href="/pricing">Pricing</a></li><li><a href="https://github.com/piiiico/proof-of-commitment" target="_blank" rel="noopener">GitHub</a></li></ul></div></nav>

<section class="hero"><div class="container">
<span class="hero-eyebrow">npm package trust score</span>
<h1 class="pkg-name">${esc(pkg)}</h1>
<p class="pkg-eco">npm &middot; ${dl}/week &middot; ${age} years old</p>
<div class="score-card">
<div><div class="score-ring"><span class="score-num">${score}</span><span class="score-of">/ 100</span></div><div style="text-align:center;margin-top:.5rem"><span class="score-grade">${risk}</span></div></div>
<div class="meta-grid">
<div class="meta-item"><span class="meta-label">npm publishers</span><span class="meta-value">${maintainers}</span></div>
<div class="meta-item"><span class="meta-label">Weekly downloads</span><span class="meta-value">${dl}</span></div>
<div class="meta-item"><span class="meta-label">Package age</span><span class="meta-value">${age} years</span></div>
<div class="meta-item"><span class="meta-label">Last published</span><span class="meta-value">${r.daysSinceLastPublish != null ? r.daysSinceLastPublish + "d ago" : "—"}</span></div>
${ghContrib ? `<div class="meta-item"><span class="meta-label">GitHub contributors</span><span class="meta-value">${ghContrib}</span></div>` : ""}
<div class="meta-item"><span class="meta-label">SLSA provenance</span><span class="meta-value">${provenance}</span></div>
<div class="meta-item"><span class="meta-label">Trusted Publishing</span><span class="meta-value">${trustedPub ? '<span style="color:#3D7A1A">OIDC &#10003;</span>' : "No"}</span></div>
<div class="meta-item"><span class="meta-label">OpenSSF Scorecard</span><span class="meta-value">${scorecard}</span></div>
<div class="meta-item"><span class="meta-label">Grade</span><span class="meta-value">${grade}</span></div>
</div></div>
</div></section>

${(r.riskFlags || []).length > 0 ? `<section class="section"><div class="container">
<h2 class="section-title">Risk flags</h2>
<div>${(r.riskFlags || []).map((f) => { const cls = f.includes("CRITICAL") ? "CRITICAL" : f.includes("HIGH") ? "HIGH" : "WARN"; return `<span class="risk-flag risk-${cls}">${esc(f)}</span>`; }).join("")}</div>
${isCritical ? `<p class="context-note" style="margin-top:1rem"><strong>${esc(pkg)} has a single npm publisher</strong> with ${dl} weekly downloads. This is the exact attack profile that enabled the <a href="/blog/axios-attack-prediction">axios compromise (March 2026)</a> and the <a href="/blog/python-supply-chain-risk">LiteLLM supply chain attack</a>. A stolen credential gives an attacker publish access to a package running on millions of machines. GitHub contributors (${ghContrib || "unknown"}) don't have npm publish rights &mdash; only the publisher does.</p>` : ""}
</div></section>` : ""}

${breakdownHtml ? `<section class="section"><div class="container">
<h2 class="section-title">Score breakdown</h2>
<p style="font-size:.85rem;color:#878580;margin-bottom:1.25rem">Five behavioral dimensions. Each measured from public registry data, not self-reported.</p>
${breakdownHtml}
</div></section>` : ""}

<section class="section"><div class="container">
<h2 class="section-title">What this score measures</h2>
<p class="context-note">The Commit trust score measures <strong>behavioral commitment</strong> &mdash; signals that are hard to fake. Unlike stars, READMEs, or download counts, these signals capture how a package is actually maintained.</p>
<ul style="margin:1rem 0 0 1.5rem;color:#575653;font-size:.95rem;line-height:2">
<li><strong>Longevity</strong> &mdash; how long the package has been published and actively maintained</li>
<li><strong>Publisher depth</strong> &mdash; number of people with npm publish access (distinct from GitHub contributors)</li>
<li><strong>Release consistency</strong> &mdash; regular releases signal active oversight</li>
<li><strong>Download trend</strong> &mdash; growing, stable, or declining adoption</li>
<li><strong>GitHub backing</strong> &mdash; contributor depth and OpenSSF Scorecard process security</li>
<li><strong>Trusted Publishing</strong> &mdash; whether the package uses <a href="https://docs.npmjs.com/generating-provenance-statements" style="color:#6F6E69;text-decoration:underline">npm OIDC provenance</a> to publish from CI, eliminating stolen-credential attacks</li>
</ul>
</div></section>

${depth2Summary && depth2Summary.criticalCount > 0 ? `<section class="section"><div class="container">
<h2 class="section-title">Depth-2 transitive risk</h2>
<p class="context-note"><strong>${depth2Summary.criticalCount}</strong> critical transitive ${depth2Summary.criticalCount === 1 ? "dependency" : "dependencies"} of <code>${esc(pkg)}</code> at depth&nbsp;2 — across ${depth2Summary.totalNodes} total nodes in the graph.</p>
<p class="context-note" style="margin-top:.75rem">How this is calculated: <a href="/blog/transitive-risk-methodology">depth-2 transitive risk methodology</a>.</p>
</div></section>` : ""}

${getRelatedArticlesHtml("npm", pkg)}

${buildMonitorCta(pkg, "npm", isCritical)}

<section class="section"><div class="container">
<h2 class="section-title">Use this data</h2>
<div class="cta-row">
<a href="/audit?packages=${encodeURIComponent(pkg)}" class="btn btn-primary">Audit your full dependency tree</a>
<a href="/quickstart" class="btn btn-ghost">Add to your CI pipeline</a>
</div>
<div style="margin-top:2rem"><h3 style="font-size:1rem;font-weight:500;margin-bottom:.5rem">CLI</h3><code>npx proof-of-commitment ${esc(pkg)}</code></div>
<div style="margin-top:1.5rem"><h3 style="font-size:1rem;font-weight:500;margin-bottom:.5rem">MCP (Claude, Cursor, Windsurf)</h3><code>{ "mcpServers": { "commit": { "type": "streamable-http", "url": "https://poc-backend.amdal-dev.workers.dev/mcp" } } }</code></div>
<div class="badge-section" style="margin-top:1.5rem"><h3 style="font-size:1rem;font-weight:500;margin-bottom:.5rem">README badge</h3><code>![Commit Trust](${badgeUrl})</code><p style="margin-top:.5rem"><img src="${badgeUrl}" alt="${esc(pkg)} commit trust badge" style="height:20px"/></p></div>
<div style="margin-top:1.5rem"><h3 style="font-size:1rem;font-weight:500;margin-bottom:.5rem">REST API</h3><code>curl -X POST ${API_BASE}/api/audit -H "Content-Type: application/json" -d '{"packages":["${esc(pkg)}"]}'</code></div>
</div></section>

<footer><div class="container">
<p><a href="/">Commit</a> &middot; Supply chain trust, measured behaviorally. <a href="/audit">Audit</a> &middot; <a href="/rankings">Rankings</a> &middot; <a href="/blog">Writing</a> &middot; <a href="https://github.com/piiiico/proof-of-commitment">GitHub</a></p>
<p style="margin-top:.5rem">Data sourced from npm registry, GitHub API, deps.dev, and OpenSSF Scorecard. Updated in real time.</p>
</div></footer>
</body></html>`;
}

function buildNpmErrorPage(pkg, error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${esc(pkg)} — Package not found — Commit</title><meta name="robots" content="noindex"/><meta name="theme-color" content="#FFFCF0"/><link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500&display=swap" rel="stylesheet"/><style>body{font-family:'Inter',system-ui,sans-serif;font-weight:300;color:#1C1B1A;background:#FFFCF0;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}h1{font-family:'Instrument Serif',Georgia,serif;font-size:2rem;margin-bottom:1rem}p{color:#575653;margin-bottom:1.5rem}a{color:#D14D41}code{font-family:'JetBrains Mono',monospace;background:#F2F0E5;border:1px solid #CECDC3;border-radius:3px;padding:.1em .35em}</style></head><body><div><h1>Package not found</h1><p><code>${esc(pkg)}</code> could not be scored. ${error ? esc(error) : "It may not exist on npm."}</p><p><a href="/audit">Try the dependency audit &rarr;</a></p></div></body></html>`;
}

// ── Generic multi-ecosystem page builder ────────────────────────────

function buildPackagePage(ecosystem, pkg, r) {
  const cfg = ECOSYSTEM_CONFIG[ecosystem] || ECOSYSTEM_CONFIG.npm;
  const score = r.score;
  const grade = scoreToGrade(score);
  const risk = riskLabel(score, r.riskFlags);
  const color = riskColor(risk);
  const dl = formatDownloads(r.weeklyDownloads || 0);
  const age = r.ageYears ? r.ageYears.toFixed(1) : "—";
  const maintainers = r.maintainers ?? "—";
  const ghContrib = r.githubContributors ?? null;
  const provenance = r.hasProvenance ? "Yes" : "No";
  const scorecard = r.scorecardScore != null ? r.scorecardScore.toFixed(1) + "/10" : "—";
  const bd = r.scoreBreakdown || {};
  const isCritical = risk === "CRITICAL";

  const ecoLabel = ecosystem.toUpperCase();
  const title = `${pkg} ${ecosystem} trust score: ${score}/100 — Commit`;
  const description = isCritical
    ? `${pkg} scores ${score}/100 on supply chain trust. CRITICAL: sole ${ecosystem} publisher with ${dl} weekly downloads. Behavioral commitment analysis by Commit.`
    : `${pkg} scores ${score}/100 on supply chain trust (Grade ${grade}). ${maintainers} ${cfg.publisherLabel}, ${dl} weekly downloads. Behavioral commitment analysis.`;

  const ogImage = `${API_BASE}/og/${ecosystem}/${encodeURIComponent(pkg)}`;
  const canonical = `https://getcommit.dev/${ecosystem}/${pkg}`;
  const badgeUrl = `${API_BASE}/badge/${ecosystem}/${encodeURIComponent(pkg)}`;

  const breakdownDims = [
    { key: "longevity", label: "Longevity", max: 25 },
    { key: "downloadMomentum", label: "Download momentum", max: 25 },
    { key: "releaseConsistency", label: "Release consistency", max: 20 },
    { key: "maintainerDepth", label: "Publisher depth", max: 15 },
    { key: "githubBacking", label: "GitHub backing", max: 15 },
  ];
  const breakdownHtml = breakdownDims.filter((d) => bd[d.key] != null).map((d) => renderBreakdownBar(d.label, bd[d.key], d.max)).join("");

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: pkg,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    aggregateRating: { "@type": "AggregateRating", ratingValue: score, bestRating: 100, worstRating: 0, ratingCount: 1, reviewCount: 1 },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    url: cfg.registryUrl(pkg),
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:type" content="website"/><meta property="og:url" content="${canonical}"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>
<meta property="og:image" content="${ogImage}"/><meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/>
<meta property="og:site_name" content="Commit"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(description)}"/><meta name="twitter:image" content="${ogImage}"/>
<meta name="theme-color" content="#FFFCF0"/>
<script type="application/ld+json">${jsonLd}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500&display=swap" rel="stylesheet"/>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"79939812e2a340758ca8cc1ded073a22"}'></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px;scroll-behavior:smooth}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;font-weight:300;font-size:1rem;line-height:1.7;color:#1C1B1A;background:#FFFCF0;min-height:100vh}
a{color:#D14D41;text-decoration:none}a:hover{text-decoration:underline}
code{font-family:'JetBrains Mono','Fira Code',monospace;font-size:.85em;background:#F2F0E5;border:1px solid #CECDC3;border-radius:3px;padding:.1em .35em}
.container{max-width:48rem;margin:0 auto;padding:0 1.5rem}
nav{padding:1rem 0;border-bottom:1px solid #CECDC3}
.nav-inner{display:flex;align-items:center;justify-content:space-between;max-width:64rem;margin:0 auto;padding:0 1.5rem}
.nav-brand{font-family:'Instrument Serif',Georgia,serif;font-size:1.4rem;color:#1C1B1A;text-decoration:none}
.nav-links{list-style:none;display:flex;gap:1.5rem;font-size:.85rem}.nav-links a{color:#575653;text-decoration:none}.nav-links a:hover{color:#1C1B1A}
.hero{padding:4rem 0 3rem}
.hero-eyebrow{font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;color:#878580}
.pkg-name{font-family:'JetBrains Mono',monospace;font-size:clamp(1.8rem,4vw,2.8rem);font-weight:400;margin:.5rem 0 .25rem;word-break:break-all}
.pkg-eco{font-size:.9rem;color:#878580;margin-bottom:1.5rem}
.score-card{display:grid;grid-template-columns:auto 1fr;gap:2.5rem;align-items:start;margin-bottom:3rem}
@media(max-width:600px){.score-card{grid-template-columns:1fr}}
.score-ring{width:140px;height:140px;border-radius:50%;border:5px solid ${color};display:flex;flex-direction:column;align-items:center;justify-content:center}
.score-num{font-family:'Instrument Serif',Georgia,serif;font-size:3rem;line-height:1;color:#1C1B1A}
.score-of{font-size:.75rem;color:#878580}
.score-grade{display:inline-block;margin-top:.75rem;padding:.2rem .75rem;font-size:.8rem;font-weight:500;letter-spacing:.05em;border-radius:3px;background:${color}15;color:${color};border:1px solid ${color}40}
.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem 2rem}
@media(max-width:600px){.meta-grid{grid-template-columns:1fr}}
.meta-item{display:flex;flex-direction:column}.meta-label{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#878580}.meta-value{font-size:1.1rem;font-weight:400}
.section{padding:2.5rem 0;border-top:1px solid #CECDC3}
.section-title{font-family:'Instrument Serif',Georgia,serif;font-size:1.5rem;margin-bottom:1.25rem}
.bd-row{display:grid;grid-template-columns:10rem 1fr 3.5rem;gap:.75rem;align-items:center;margin-bottom:.6rem}
@media(max-width:600px){.bd-row{grid-template-columns:7rem 1fr 3rem;gap:.5rem}}
.bd-label{font-size:.85rem;color:#575653}.bd-track{height:8px;background:#E6E4D9;border-radius:4px;overflow:hidden}
.bd-fill{height:100%;border-radius:4px}.bd-fill.bar-ok{background:#879A39}.bd-fill.bar-warn{background:#D0A215}.bd-fill.bar-low{background:#D14D41}
.bd-val{font-family:'JetBrains Mono',monospace;font-size:.8rem;color:#575653;text-align:right}.bd-max{color:#878580}
.risk-flag{display:inline-block;padding:.3rem .8rem;font-size:.8rem;font-weight:500;border-radius:3px;margin-right:.5rem;margin-bottom:.5rem}
.risk-CRITICAL{background:#D14D4118;color:#AF3029;border:1px solid #D14D4140}
.risk-HIGH{background:#DA702C18;color:#BC5215;border:1px solid #DA702C40}
.risk-WARN{background:#D0A21518;color:#AD8301;border:1px solid #D0A21540}
.cta-row{display:flex;flex-wrap:wrap;gap:1rem;margin:2rem 0}
.btn{display:inline-block;padding:.65rem 1.5rem;border-radius:4px;font-size:.9rem;font-weight:500;text-decoration:none}
.btn-primary{background:#D14D41;color:#fff}.btn-primary:hover{background:#AF3029;text-decoration:none}
.btn-ghost{background:transparent;color:#1C1B1A;border:1px solid #CECDC3}.btn-ghost:hover{border-color:#1C1B1A;text-decoration:none}
.badge-section code{display:block;padding:.75rem 1rem;overflow-x:auto;white-space:pre;font-size:.82rem}
.context-note{font-size:.95rem;line-height:1.7;color:#575653}.context-note strong{color:#1C1B1A;font-weight:500}
footer{padding:3rem 0;border-top:1px solid #CECDC3;margin-top:3rem}footer p{font-size:.8rem;color:#878580}footer a{color:#878580}
</style>
</head>
<body>
<nav><div class="nav-inner"><a href="/" class="nav-brand">Commit</a><ul class="nav-links"><li><a href="/quickstart">Quickstart</a></li><li><a href="/audit">Audit</a></li><li><a href="/rankings">Rankings</a></li><li><a href="/blog">Writing</a></li><li><a href="/pricing">Pricing</a></li><li><a href="https://github.com/piiiico/proof-of-commitment" target="_blank" rel="noopener">GitHub</a></li></ul></div></nav>

<section class="hero"><div class="container">
<span class="hero-eyebrow">${esc(cfg.eyebrow)}</span>
<h1 class="pkg-name">${esc(pkg)}</h1>
<p class="pkg-eco">${esc(cfg.siteName)} &middot; ${dl}/week &middot; ${age} years old</p>
<div class="score-card">
<div><div class="score-ring"><span class="score-num">${score}</span><span class="score-of">/ 100</span></div><div style="text-align:center;margin-top:.5rem"><span class="score-grade">${risk}</span></div></div>
<div class="meta-grid">
<div class="meta-item"><span class="meta-label">${esc(cfg.publisherLabel)}</span><span class="meta-value">${maintainers}</span></div>
<div class="meta-item"><span class="meta-label">Weekly downloads</span><span class="meta-value">${dl}</span></div>
<div class="meta-item"><span class="meta-label">Package age</span><span class="meta-value">${age} years</span></div>
<div class="meta-item"><span class="meta-label">Last published</span><span class="meta-value">${r.daysSinceLastPublish != null ? r.daysSinceLastPublish + "d ago" : "—"}</span></div>
${ghContrib ? `<div class="meta-item"><span class="meta-label">GitHub contributors</span><span class="meta-value">${ghContrib}</span></div>` : ""}
${ecosystem !== "go" ? `<div class="meta-item"><span class="meta-label">Provenance</span><span class="meta-value">${provenance}</span></div>` : ""}
<div class="meta-item"><span class="meta-label">OpenSSF Scorecard</span><span class="meta-value">${scorecard}</span></div>
<div class="meta-item"><span class="meta-label">Grade</span><span class="meta-value">${grade}</span></div>
</div></div>
</div></section>

${(r.riskFlags || []).length > 0 ? `<section class="section"><div class="container">
<h2 class="section-title">Risk flags</h2>
<div>${(r.riskFlags || []).map((f) => { const cls = f.includes("CRITICAL") ? "CRITICAL" : f.includes("HIGH") ? "HIGH" : "WARN"; return `<span class="risk-flag risk-${cls}">${esc(f)}</span>`; }).join("")}</div>
</div></section>` : ""}

${breakdownHtml ? `<section class="section"><div class="container">
<h2 class="section-title">Score breakdown</h2>
<p style="font-size:.85rem;color:#878580;margin-bottom:1.25rem">Five behavioral dimensions. Each measured from public registry data, not self-reported.</p>
${breakdownHtml}
</div></section>` : ""}

<section class="section"><div class="container">
<h2 class="section-title">What this score measures</h2>
<p class="context-note">The Commit trust score measures <strong>behavioral commitment</strong> &mdash; signals that are hard to fake. Unlike stars, READMEs, or download counts, these signals capture how a package is actually maintained.</p>
<ul style="margin:1rem 0 0 1.5rem;color:#575653;font-size:.95rem;line-height:2">
<li><strong>Longevity</strong> &mdash; how long the package has been published and actively maintained</li>
<li><strong>Publisher depth</strong> &mdash; number of people with ${esc(cfg.siteName)} publish access</li>
<li><strong>Release consistency</strong> &mdash; regular releases signal active oversight</li>
<li><strong>Download trend</strong> &mdash; growing, stable, or declining adoption</li>
<li><strong>GitHub backing</strong> &mdash; contributor depth and OpenSSF Scorecard process security</li>
</ul>
</div></section>

${getRelatedArticlesHtml(ecosystem, pkg)}

${buildMonitorCta(pkg, ecosystem, isCritical)}

<section class="section"><div class="container">
<h2 class="section-title">Use this data</h2>
<div class="cta-row">
<a href="/audit?packages=${encodeURIComponent(pkg)}&ecosystem=${ecosystem}" class="btn btn-primary">Audit your full dependency tree</a>
<a href="/quickstart" class="btn btn-ghost">Add to your CI pipeline</a>
</div>
<div style="margin-top:2rem"><h3 style="font-size:1rem;font-weight:500;margin-bottom:.5rem">CLI</h3><code>${esc(cfg.cliCmd(pkg))}</code></div>
<div style="margin-top:1.5rem"><h3 style="font-size:1rem;font-weight:500;margin-bottom:.5rem">MCP (Claude, Cursor, Windsurf)</h3><code>{ "mcpServers": { "commit": { "type": "streamable-http", "url": "https://poc-backend.amdal-dev.workers.dev/mcp" } } }</code></div>
<div class="badge-section" style="margin-top:1.5rem"><h3 style="font-size:1rem;font-weight:500;margin-bottom:.5rem">README badge</h3><code>![Commit Trust](${badgeUrl})</code><p style="margin-top:.5rem"><img src="${badgeUrl}" alt="${esc(pkg)} commit trust badge" style="height:20px"/></p></div>
<div style="margin-top:1.5rem"><h3 style="font-size:1rem;font-weight:500;margin-bottom:.5rem">REST API</h3><code>curl -X POST ${API_BASE}/api/audit -H "Content-Type: application/json" -d '{"packages":["${esc(pkg)}"],"ecosystem":"${ecosystem}"}'</code></div>
</div></section>

<footer><div class="container">
<p><a href="/">Commit</a> &middot; Supply chain trust, measured behaviorally. <a href="/audit">Audit</a> &middot; <a href="/rankings">Rankings</a> &middot; <a href="/blog">Writing</a> &middot; <a href="https://github.com/piiiico/proof-of-commitment">GitHub</a></p>
<p style="margin-top:.5rem">Data sourced from ${esc(cfg.siteName)}, GitHub API, deps.dev, and OpenSSF Scorecard. Updated in real time.</p>
</div></footer>
</body></html>`;
}

function buildPackageErrorPage(ecosystem, pkg, error) {
  const cfg = ECOSYSTEM_CONFIG[ecosystem] || ECOSYSTEM_CONFIG.npm;
  const notFoundMsg = `It may not exist on ${cfg.siteName}.`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${esc(pkg)} — Package not found — Commit</title><meta name="robots" content="noindex"/><meta name="theme-color" content="#FFFCF0"/><link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500&display=swap" rel="stylesheet"/><style>body{font-family:'Inter',system-ui,sans-serif;font-weight:300;color:#1C1B1A;background:#FFFCF0;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}h1{font-family:'Instrument Serif',Georgia,serif;font-size:2rem;margin-bottom:1rem}p{color:#575653;margin-bottom:1.5rem}a{color:#D14D41}code{font-family:'JetBrains Mono',monospace;background:#F2F0E5;border:1px solid #CECDC3;border-radius:3px;padding:.1em .35em}</style></head><body><div><h1>Package not found</h1><p><code>${esc(pkg)}</code> could not be scored. ${error ? esc(error) : notFoundMsg}</p><p><a href="/audit">Try the dependency audit &rarr;</a></p></div></body></html>`;
}

// GENERATED-EDIT-OK: source-of-truth file — adding env param for SSR rate-limit bypass token
async function handlePackagePage(ecosystem, pkg, env) {
  try {
    const apiRes = await fetch(`${API_BASE}/api/audit`, {
      method: "POST",
      headers: ssrHeaders(env),
      body: JSON.stringify({ packages: [pkg], ecosystem }),
    });
    if (!apiRes.ok) {
      return new Response(buildPackageErrorPage(ecosystem, pkg, "API error."), { status: 502, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    const data = await apiRes.json();
    const result = data.results?.[0];
    if (!result || result.error || result.score == null) {
      return new Response(buildPackageErrorPage(ecosystem, pkg, result?.error), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    return new Response(buildPackagePage(ecosystem, pkg, result), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
  } catch {
    return new Response(buildPackageErrorPage(ecosystem, pkg, "Service temporarily unavailable."), { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  }
}

// GENERATED-EDIT-OK: source-of-truth file — adding env param for SSR rate-limit bypass token
async function handleNpmPage(pkg, env) {
  try {
    const [apiRes, depth2Res] = await Promise.allSettled([
      fetch(`${API_BASE}/api/audit`, {
        method: "POST",
        headers: ssrHeaders(env),
        body: JSON.stringify({ packages: [pkg], ecosystem: "npm" }),
      }),
      fetch(`${API_BASE}/api/graph/npm/${encodeURIComponent(pkg)}`, { cf: { cacheTtl: 3600 } }),
    ]);
    if (apiRes.status !== "fulfilled" || !apiRes.value.ok) {
      return new Response(buildNpmErrorPage(pkg, "API error."), { status: 502, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    const data = await apiRes.value.json();
    const result = data.results?.[0];
    if (!result || result.error || result.score == null) {
      return new Response(buildNpmErrorPage(pkg, result?.error), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    let depth2Summary = null;
    try {
      if (depth2Res.status === "fulfilled" && depth2Res.value.ok) {
        const depth2Json = await depth2Res.value.json();
        depth2Summary = depth2Json.summary;
      }
    } catch (e) { /* fail open — don't break the page */ }
    return new Response(buildNpmPage(pkg, result, depth2Summary), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
  } catch {
    return new Response(buildNpmErrorPage(pkg, "Service temporarily unavailable."), { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  }
}

// ── /scan/:pkg crawler page helpers ─────────────────────────────────

// GENERATED-EDIT-OK: source-of-truth file — adding env param for SSR rate-limit bypass token
async function handleScanCrawler(pkg, requestUrl, env) {
  const ecoSlug = "npm"; // Default; will be overridden after API call
  let score = null;
  let riskFlags = [];
  let resolvedEco = "npm";

  try {
    const apiRes = await fetch(`${API_BASE}/api/audit`, {
      method: "POST",
      headers: ssrHeaders(env),
      body: JSON.stringify({ packages: [pkg], ecosystem: "auto" }),
    });

    if (apiRes.ok) {
      const data = await apiRes.json();
      const result = data.results?.[0];
      if (result && !result.error && result.score !== null) {
        score = result.score;
        riskFlags = result.riskFlags ?? [];
        resolvedEco = result.ecosystem ?? "npm";
      }
    }
  } catch {
    // Fall through with nulls
  }

  const ogImageUrl = `${API_BASE}/og/${resolvedEco}/${encodeURIComponent(pkg)}`;
  const pageUrl = `https://getcommit.dev/scan/${encodeURIComponent(pkg)}`;
  const spaUrl = `/scan/?pkg=${encodeURIComponent(pkg)}`;
  const grade = score !== null ? scoreToGrade(score) : null;
  const label = score !== null ? scoreToLabel(score, riskFlags) : "unknown";

  const ogTitle =
    score !== null
      ? `${pkg} — Trust Score: ${score}/100 (${grade}) · Commit`
      : `${pkg} · Commit Package Score`;

  const ogDescription =
    score !== null
      ? `${pkg} scored ${score}/100 on supply chain trust. Grade: ${grade} — ${label}. Behavioral commitment score based on maintainers, download trends, and release consistency.`
      : `View the supply chain trust score for ${pkg} on getcommit.dev.`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${esc(ogTitle)}</title>
  <meta name="description" content="${esc(ogDescription)}"/>

  <!-- Open Graph -->
  <meta property="og:type" content="website"/>
  <meta property="og:url" content="${esc(pageUrl)}"/>
  <meta property="og:title" content="${esc(ogTitle)}"/>
  <meta property="og:description" content="${esc(ogDescription)}"/>
  <meta property="og:image" content="${esc(ogImageUrl)}"/>
  <meta property="og:image:width" content="1200"/>
  <meta property="og:image:height" content="630"/>
  <meta property="og:image:type" content="image/png"/>
  <meta property="og:site_name" content="Commit — Trust Scores"/>

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${esc(ogTitle)}"/>
  <meta name="twitter:description" content="${esc(ogDescription)}"/>
  <meta name="twitter:image" content="${esc(ogImageUrl)}"/>
  <meta name="twitter:image:alt" content="${esc(pkg)} trust score: ${score !== null ? `${score}/100` : "unknown"}"/>

  <link rel="canonical" href="${esc(pageUrl)}"/>
  <script>window.location.replace("${spaUrl}")</script>
</head>
<body>
  <p>Loading score for <strong>${esc(pkg)}</strong>…</p>
  <p><a href="${spaUrl}">View score →</a></p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "X-Robots-Tag": "noindex",
    },
  });
}

// ── IndexNow ────────────────────────────────────────────────────────
// Per the IndexNow protocol (https://www.indexnow.org/documentation),
// search engines (Bing, Yandex, Seznam, Naver) verify ownership by
// fetching a key file at /<key>.txt that contains exactly the key.
// We serve it both via static asset and via an explicit route so the
// key remains reachable even if the static binding is misconfigured.
// Post-deploy pings: scripts/indexnow-ping.ts (called from deploy.ts).
const INDEXNOW_KEY = "db5e07761dea0e248ef94747c9ccd9ba";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── IndexNow key verification ────────────────────────────────────
    if (path === `/${INDEXNOW_KEY}.txt`) {
      return new Response(INDEXNOW_KEY, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=86400",
        },
      });
    }

    // ── /npm/:pkg SSR package profile pages ──────────────────────────
    const npmMatch = path.match(/^\/npm\/(.+?)(?:\/)?$/);
    if (npmMatch) {
      const pkg = decodeURIComponent(npmMatch[1]);
// GENERATED-EDIT-OK: source-of-truth file — passing env to handlers for SSR rate-limit bypass
      if (pkg) return handleNpmPage(pkg, env);
      return Response.redirect("https://getcommit.dev/audit", 302);
    }

    // ── /pypi/:pkg SSR PyPI package profile pages ─────────────────────
    const pypiMatch = path.match(/^\/pypi\/(.+?)(?:\/)?$/);
    if (pypiMatch) {
      const pkg = decodeURIComponent(pypiMatch[1]);
      if (pkg) return handlePackagePage("pypi", pkg, env);
      return Response.redirect("https://getcommit.dev/audit", 302);
    }

    // ── /cargo/:pkg SSR Cargo crate profile pages ─────────────────────
    const cargoMatch = path.match(/^\/cargo\/(.+?)(?:\/)?$/);
    if (cargoMatch) {
      const pkg = decodeURIComponent(cargoMatch[1]);
      if (pkg) return handlePackagePage("cargo", pkg, env);
      return Response.redirect("https://getcommit.dev/audit", 302);
    }

    // ── /go/:module SSR Go module profile pages (path may have slashes) ─
    const goMatch = path.match(/^\/go\/(.+?)(?:\/)?$/);
    if (goMatch) {
      const mod = decodeURIComponent(goMatch[1]);
      if (mod) return handlePackagePage("go", mod, env);
      return Response.redirect("https://getcommit.dev/audit", 302);
    }

    // ── /scan/* routing ──────────────────────────────────────────────
    // Match /scan/SOMETHING (but not /scan/ itself)
    const scanMatch = path.match(/^\/scan\/(.+?)(?:\/)?$/);
    if (scanMatch) {
      const rawPkg = decodeURIComponent(scanMatch[1]);

      // Static sub-pages: /scan/repo → serve as static asset
      if (rawPkg === "repo" || rawPkg === "index") {
        return env.ASSETS.fetch(request);
      }

      const ua = request.headers.get("User-Agent") || "";

// GENERATED-EDIT-OK: source-of-truth file — passing env for SSR bypass
      if (isCrawler(ua)) {
        return handleScanCrawler(rawPkg, url, env);
      } else {
        // Regular browser: redirect to SPA
        const target = new URL(url.origin + "/scan/");
        target.search = "?pkg=" + encodeURIComponent(rawPkg);
        return Response.redirect(target.toString(), 302);
      }
    }

    // ── /api/subscribe proxy ─────────────────────────────────────────
    if (path === "/api/subscribe") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }
      if (request.method !== "POST") {
        return new Response(null, {
          status: 405,
          headers: { "Allow": "POST, OPTIONS", "Access-Control-Allow-Origin": "*" },
        });
      }
      try {
        const upstream = await fetch(`${API_BASE}/api/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: request.body,
        });
        const data = await upstream.json();
        return new Response(JSON.stringify(data), {
          status: upstream.status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch {
        return new Response(JSON.stringify({ ok: false, message: "Subscribe failed" }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ── All other blog redirects from _redirects ─────────────────────
    // Replicate the blog redirects here since _worker.js bypasses _redirects
    const BLOG_REDIRECTS = {
      "/blog/agents-can-pay": "https://agentlair.dev/blog/agents-can-pay",
      "/blog/building-on-visa-tap": "https://agentlair.dev/blog/building-on-visa-tap",
      "/blog/mastercard-vi-l4-gap": "https://agentlair.dev/blog/mastercard-vi-l4-gap",
      "/blog/rsac-2026-confirmed-the-gap": "https://agentlair.dev/blog/rsac-2026-confirmed-the-gap",
      "/blog/the-agent-passed-all-the-checks": "https://agentlair.dev/blog/the-agent-passed-all-the-checks",
      "/blog/who-decides-what-agents-can-buy": "https://agentlair.dev/blog/who-decides-what-agents-can-buy",
      "/blog/135000-frameworks-zero-governance": "https://agentlair.dev/blog/135000-frameworks-zero-governance",
      "/blog/litellm-supply-chain-mcp": "https://agentlair.dev/blog/litellm-supply-chain-mcp",
      "/blog/claude-code-source-leak-fake-repos": "https://agentlair.dev/blog/claude-code-source-leak-fake-repos",
      "/blog/claude-code-behavioral-telemetry": "https://agentlair.dev/blog/claude-code-behavioral-telemetry",
      "/blog/emdash-trust-guard": "https://agentlair.dev/blog/emdash-trust-guard",
      "/blog/mythos-paradox": "https://agentlair.dev/blog/mythos-paradox",
      "/blog/behavioral-trust-without-surveillance": "https://agentlair.dev/blog/behavioral-trust-without-surveillance",
      "/blog/quantum-deadline-agent-credentials": "https://agentlair.dev/blog/quantum-deadline-agent-credentials",
      "/blog/sixty-percent-want-approval-gates": "https://agentlair.dev/blog/sixty-percent-want-approval-gates",
    };

    const cleanPath = path.replace(/\/$/, ""); // strip trailing slash
    const blogTarget = BLOG_REDIRECTS[cleanPath];
    if (blogTarget) {
      return Response.redirect(blogTarget, 301);
    }

    // ── /robots.txt ──────────────────────────────────────────────────
    if (cleanPath === "/robots.txt") {
      return new Response(
        "User-agent: *\nAllow: /\n\nSitemap: https://getcommit.dev/sitemap-index.xml\n",
        { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } }
      );
    }

    // ── /sitemap.xml — conventional alias ─────────────────────────────
    // Many crawlers (including Google) try /sitemap.xml first regardless of robots.txt
    if (cleanPath === "/sitemap.xml") {
      return Response.redirect("https://getcommit.dev/sitemap-index.xml", 301);
    }

    // ── /sitemap-index.xml — master sitemap index ────────────────────
    if (cleanPath === "/sitemap-index.xml" || cleanPath === "/sitemap-index") {
      const today = new Date().toISOString().split("T")[0];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://getcommit.dev/sitemap-pages.xml</loc><lastmod>${today}</lastmod></sitemap>
  <sitemap><loc>https://getcommit.dev/sitemap-blog.xml</loc><lastmod>${today}</lastmod></sitemap>
  <sitemap><loc>https://getcommit.dev/sitemap-npm.xml</loc><lastmod>${today}</lastmod></sitemap>
  <sitemap><loc>https://getcommit.dev/sitemap-pypi.xml</loc><lastmod>${today}</lastmod></sitemap>
  <sitemap><loc>https://getcommit.dev/sitemap-cargo.xml</loc><lastmod>${today}</lastmod></sitemap>
  <sitemap><loc>https://getcommit.dev/sitemap-go.xml</loc><lastmod>${today}</lastmod></sitemap>
</sitemapindex>`;
      return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    }

    // ── /sitemap-pages.xml — core site pages ─────────────────────────
    if (cleanPath === "/sitemap-pages.xml" || cleanPath === "/sitemap-pages") {
      const pages = [
        "/","/audit","/pricing","/docs","/get-started","/quickstart",
        "/extension","/badges","/compare","/dashboard","/rankings",
        "/thesis","/spec","/watchlist","/privacy",
        "/scan","/scan/repo",
      ];
      const today = new Date().toISOString().split("T")[0];
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      for (const p of pages) {
        // GENERATED-EDIT-OK: public/_worker.js is hand-written source per file header line 1; only dist/_worker.js is the build artifact. Sitemap must emit post-redirect URLs (trailing slash) to match canonical tags — fixes 78-page Google indexing gap diagnosed 2026-05-23.
        const loc = p === "/" ? p : `${p}/`;
        xml += `  <url><loc>https://getcommit.dev${loc}</loc><changefreq>weekly</changefreq><lastmod>${today}</lastmod><priority>0.8</priority></url>\n`;
      }
      xml += `</urlset>`;
      return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    }

    // ── /sitemap-blog.xml — all blog articles ────────────────────────
    if (cleanPath === "/sitemap-blog.xml" || cleanPath === "/sitemap-blog") {
      // NOTE: Excludes slugs that 301-redirect to agentlair.dev — those belong in agentlair's sitemap
      // GENERATED-EDIT-OK: adding 4 missing blog slugs to sitemap (stripe-google-cloud-critical, antv, checklist, two-attacks) + drizzle-kit-stale-transitive-dep (2026-05-25)
      const blogSlugs = [
        "drizzle-kit-stale-transitive-dep",
        "stripe-google-cloud-critical",
        "antv-supply-chain-attack",
        "npm-supply-chain-audit-checklist",
        "two-attacks-one-week",
        "tanstack-mini-shai-hulud-behavioral-analysis",
        "npm-trusted-publishing-provenance","critical-flag-silent-regression",
        "compliance-theater-behavioral-proof","scorecard-vs-behavioral",
        "github-repo-scanner","trusted-publishing-adoption",
        "transitive-risk-methodology","four-ecosystems-one-vulnerability",
        "go-supply-chain-different-risk","pnpm-monorepo-supply-chain-audit",
        "cargo-supply-chain-risk","ai-slop-commitment-problem",
        "evaluation-awareness","python-supply-chain-risk",
        "behavioral-trust-vs-surveillance","express-supply-chain",
        "invisible-critical-packages","agents-md-package-trust",
        "proof-of-commitment-internals","lockfile-scan",
        "25-npm-packages-scored","3000-autonomous-agent-tasks","after-agents-week",
        "agents-installing-dependencies",
        "ai-lies-about-your-favorite-restaurant","ai-sdk-supply-chain-ranking",
        "amazon-perplexity-platform-trust",
        "anthropic-sdk-transitive-risk","axios-attack-prediction",
        "benchmarks-lied","benchmarks-soc2",
        "bitwarden-cli-scored-92",
        "caveman-pricing-principle","ci-trust-scoring-tutorial",
        "cloudflare-pre-iam-moment","commit-vs-socket-snyk-npm-audit",
        "commitment-is-the-new-link","declarations-are-gameable",
        "event-stream-autopsy",
        "five-identity-frameworks","five-stars-zero-commitment",
        "germany-eidas-runtime-attestation","hono-critical",
        "how-commit-extension-works",
        "mcp-security-crisis","mcp-security-landscape-2026",
        "mcp-server-60-seconds","npm-audit-zero-vulnerabilities",
        "npm-trust-q2-2026","payment-layer-governance",
        "scoring-methodology",
        "state-of-npm-trust-april-2026",
        "the-10-billion-trust-data-market",
        "the-axios-signal","the-missing-layer",
        "three-npm-disasters-that-were-predictable","toctou-of-trust",
        "trust-gap-agentic-infrastructure","two-types-npm-attacks",
      ];
      const today = new Date().toISOString().split("T")[0];
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      // GENERATED-EDIT-OK: hand-written source (header line 1); trailing-slash sitemap entries match canonical-tag URLs, fixing the redirect+canonical loop that suppressed blog indexing (78 pages diagnosed 2026-05-23).
      xml += `  <url><loc>https://getcommit.dev/blog/</loc><changefreq>daily</changefreq><lastmod>${today}</lastmod><priority>0.9</priority></url>\n`;
      for (const slug of blogSlugs) {
        xml += `  <url><loc>https://getcommit.dev/blog/${slug}/</loc><changefreq>monthly</changefreq><lastmod>${today}</lastmod><priority>0.7</priority></url>\n`;
      }
      xml += `</urlset>`;
      return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    }

    // ── /sitemap-npm.xml — top 200 npm packages ─────────────────────
    if (cleanPath === "/sitemap-npm.xml" || cleanPath === "/sitemap-npm") {
      const topPackages = [
        "semver","lru-cache","minimatch","ansi-styles","debug","strip-ansi",
        "ms","chalk","supports-color","commander","string-width","tslib",
        "wrap-ansi","picomatch","glob","glob-parent","@types/node","source-map",
        "color-name","color-convert","ajv","readable-stream","escape-string-regexp",
        "has-flag","which","locate-path","json-schema-traverse","p-limit",
        "p-locate","uuid","yallist","signal-exit","safe-buffer",
        "is-fullwidth-code-point","isarray","js-yaml","esbuild","postcss",
        "path-key","shebang-command","shebang-regex","typescript","acorn",
        "yargs","fs-extra","mime-types","picocolors","cross-spawn","nanoid",
        "hasown","path-to-regexp","resolve-from","path-exists","get-stream",
        "p-try","punycode","inherits","is-number","cookie","caniuse-lite",
        "chokidar","electron-to-chromium","is-glob","micromatch","braces",
        "form-data","lodash","graceful-fs","node-releases","escalade",
        "get-intrinsic","fast-deep-equal","browserslist","fill-range",
        "to-regex-range","gopd","yaml","rimraf","fast-glob","execa",
        "node-fetch","react-dom","@babel/core","has-symbols","es-errors",
        "es-define-property","http-errors","dotenv","normalize-path","react",
        "eslint","statuses","import-fresh","callsites","is-core-module",
        "update-browserslist-db","fast-json-stable-stringify","uri-js","fastq",
        "npm-run-path","reusify","run-parallel","kind-of","parent-module",
        "mkdirp","cosmiconfig","depd","json-buffer","keyv","mime","encodeurl",
        "deep-is","finalhandler","anymatch","raw-body","send","undici",
        "content-disposition","axios","once","side-channel","object-inspect",
        "queue-microtask","prettier","tailwindcss","vite","rollup","type-is",
        "body-parser","express","clsx","bytes","accepts","on-finished",
        "cookie-signature","prop-types","fresh","merge-descriptors","date-fns",
        "content-type","define-data-property","is-typed-array","range-parser",
        "etag","object.assign","set-function-length","deepmerge","chai","vary",
        "call-bind","proxy-addr","regenerator-runtime","core-js","terser",
        "sharp","vitest","cors","destroy","utils-merge","playwright",
        "react-router","http-cache-semantics","webpack","immer","dayjs","jest",
        "through2","react-router-dom","@swc/core","graphql","zustand","next",
        "compression","moment","redux","husky","sass","css-loader","classnames",
        "react-redux","babel-loader","lint-staged","preact","style-loader",
        "@emotion/react","multer","socket.io","mocha","d3","socket.io-client",
        "webpack-cli","vue","yup","helmet","morgan","less","redis","sinon",
        "mysql2","puppeteer","@nestjs/core","@nestjs/common","cookie-parser",
        "@prisma/client","nx","drizzle-orm","three","cypress","zod","turbo",
        "pg","sequelize","mongoose","svelte","formik","hono","fastify",
        "firebase","bcrypt","typeorm","knex","openai","@anthropic-ai/sdk",
        "crypto-js","cross-env","bluebird","ejs","got","archiver","nodemon",
      ];
      const today = new Date().toISOString().split("T")[0];
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      for (const pkg of topPackages) {
        xml += `  <url><loc>https://getcommit.dev/npm/${encodeURIComponent(pkg).replace(/%40/g, "@")}</loc><changefreq>weekly</changefreq><lastmod>${today}</lastmod></url>\n`;
      }
      xml += `</urlset>`;
      return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    }

    // ── /sitemap-pypi.xml — top 100 PyPI packages ───────────────────
    if (cleanPath === "/sitemap-pypi.xml" || cleanPath === "/sitemap-pypi") {
      const topPypi = [
        "boto3","packaging","urllib3","certifi","requests","typing-extensions",
        "idna","charset-normalizer","setuptools","botocore","cryptography",
        "aiobotocore","python-dateutil","six","pyyaml","cffi","pydantic",
        "pygments","click","numpy","grpcio-status","pycparser","pydantic-core",
        "pluggy","s3transfer","protobuf","anyio","attrs","h11","fsspec",
        "annotated-types","pytest","pandas","httpx","iniconfig","httpcore",
        "s3fs","typing-inspection","markupsafe","platformdirs","python-dotenv",
        "pip","jinja2","pyjwt","jmespath","importlib-metadata","rich",
        "filelock","aiohttp","zipp","pathspec","wheel","jsonschema",
        "markdown-it-py","pytz","pyasn1","multidict","yarl","mdurl",
        "googleapis-common-protos","starlette","uvicorn","google-auth",
        "rpds-py","tzdata","propcache","frozenlist","referencing","pillow",
        "tqdm","google-api-core","jsonschema-specifications","virtualenv",
        "aiosignal","grpcio","fastapi","colorama","aiohappyeyeballs","awscli",
        "greenlet","pyasn1-modules","pyarrow","requests-oauthlib","wrapt",
        "opentelemetry-api","scipy","tomli","tenacity","pyparsing","sqlalchemy",
        "opentelemetry-semantic-conventions","opentelemetry-sdk","typer",
        "beautifulsoup4","websockets","oauthlib","soupsieve","psutil",
        "python-multipart","lxml","sniffio","regex","flask","django",
        "langchain","litellm",
      ];
      const today = new Date().toISOString().split("T")[0];
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      for (const pkg of topPypi) {
        xml += `  <url><loc>https://getcommit.dev/pypi/${encodeURIComponent(pkg)}</loc><changefreq>weekly</changefreq><lastmod>${today}</lastmod></url>\n`;
      }
      xml += `</urlset>`;
      return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    }

    // ── /sitemap-cargo.xml — top 80 Rust crates ─────────────────────
    if (cleanPath === "/sitemap-cargo.xml" || cleanPath === "/sitemap-cargo") {
      const topCargo = [
        "syn","hashbrown","bitflags","getrandom","rand_core","libc",
        "proc-macro2","base64","rand","quote","indexmap","regex-syntax",
        "itertools","cfg-if","windows-sys","serde","thiserror-impl",
        "thiserror","rand_chacha","memchr","unicode-ident","serde_derive",
        "itoa","autocfg","heck","serde_json","regex-automata","once_cell",
        "log","cc","regex","ryu","socket2","clap","smallvec","aho-corasick",
        "parking_lot_core","rustix","parking_lot","strsim","lazy_static",
        "num-traits","version_check","bytes","semver","windows-targets","mio",
        "either","lock_api","pin-project-lite","digest","idna","http",
        "block-buffer","anyhow","scopeguard","tokio","time","miniz_oxide",
        "hyper","ppv-lite86","crossbeam-utils","rustls","percent-encoding",
        "slab","fastrand","url","futures-core","toml","generic-array",
        "futures-util","futures-task","sha2","tracing-core","clap_lex",
        "http-body","typenum","futures-sink","byteorder","futures-channel",
        "tracing","axum","tower","reqwest","openssl","uuid","hex","ring",
      ];
      const today = new Date().toISOString().split("T")[0];
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      for (const pkg of topCargo) {
        xml += `  <url><loc>https://getcommit.dev/cargo/${encodeURIComponent(pkg)}</loc><changefreq>weekly</changefreq><lastmod>${today}</lastmod></url>\n`;
      }
      xml += `</urlset>`;
      return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    }

    // ── /sitemap-go.xml — top 60 Go modules ─────────────────────────
    if (cleanPath === "/sitemap-go.xml" || cleanPath === "/sitemap-go") {
      const topGo = [
        "github.com/gin-gonic/gin",
        "github.com/gorilla/mux",
        "github.com/labstack/echo/v4",
        "github.com/gofiber/fiber/v2",
        "github.com/go-chi/chi/v5",
        "github.com/stretchr/testify",
        "github.com/sirupsen/logrus",
        "go.uber.org/zap",
        "github.com/spf13/cobra",
        "github.com/spf13/viper",
        "github.com/spf13/afero",
        "github.com/spf13/pflag",
        "github.com/spf13/cast",
        "github.com/aws/aws-sdk-go",
        "github.com/aws/aws-sdk-go-v2",
        "google.golang.org/grpc",
        "google.golang.org/protobuf",
        "github.com/golang/protobuf",
        "github.com/google/uuid",
        "github.com/google/go-cmp",
        "github.com/prometheus/client_golang",
        "github.com/prometheus/common",
        "go.opentelemetry.io/otel",
        "github.com/hashicorp/consul",
        "github.com/hashicorp/vault",
        "github.com/hashicorp/terraform",
        "github.com/hashicorp/go-multierror",
        "github.com/hashicorp/hcl",
        "github.com/docker/docker",
        "github.com/docker/cli",
        "k8s.io/client-go",
        "k8s.io/api",
        "k8s.io/apimachinery",
        "sigs.k8s.io/controller-runtime",
        "github.com/go-playground/validator/v10",
        "github.com/go-redis/redis/v9",
        "github.com/jackc/pgx/v5",
        "gorm.io/gorm",
        "gorm.io/driver/postgres",
        "github.com/jmoiron/sqlx",
        "github.com/lib/pq",
        "github.com/mattn/go-sqlite3",
        "github.com/go-sql-driver/mysql",
        "github.com/onsi/ginkgo/v2",
        "github.com/onsi/gomega",
        "github.com/rs/zerolog",
        "github.com/pkg/errors",
        "github.com/fatih/color",
        "github.com/urfave/cli/v2",
        "github.com/mitchellh/mapstructure",
        "github.com/pelletier/go-toml/v2",
        "github.com/gorilla/websocket",
        "github.com/grpc-ecosystem/grpc-gateway/v2",
        "github.com/samber/lo",
        "github.com/shopspring/decimal",
        "github.com/golangci/golangci-lint",
        "github.com/nats-io/nats.go",
        "github.com/redis/go-redis/v9",
        "github.com/elastic/go-elasticsearch/v8",
        "github.com/caarlos0/env/v11",
      ];
      const today = new Date().toISOString().split("T")[0];
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      for (const mod of topGo) {
        xml += `  <url><loc>https://getcommit.dev/go/${mod}</loc><changefreq>weekly</changefreq><lastmod>${today}</lastmod></url>\n`;
      }
      xml += `</urlset>`;
      return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
    }

    // ── Everything else: serve static assets ─────────────────────────
    return env.ASSETS.fetch(request);
  },
};
