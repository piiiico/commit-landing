#!/usr/bin/env bun
/**
 * IndexNow submission — pings Bing / Yandex / Seznam / Naver with our URLs.
 *
 * Protocol: https://www.indexnow.org/documentation
 * Endpoint: POST https://api.indexnow.org/IndexNow
 *
 * Key file is served at https://getcommit.dev/<key>.txt (static asset).
 *
 * What we submit on every deploy:
 * - All URLs in sitemap-pages.xml  (landing pages, ~17)
 * - All URLs in sitemap-blog.xml   (blog posts, ~100)
 *
 * Package sitemaps (npm/pypi/cargo/go) are NOT submitted in bulk — too many,
 * would look like spam. Search engines crawl the sitemap-index.xml on their
 * own cadence to discover those.
 *
 * Usage:
 *   bun scripts/indexnow-ping.ts                  # ping with sitemap-pages + sitemap-blog
 *   bun scripts/indexnow-ping.ts --include-npm    # add top npm package pages
 *   bun scripts/indexnow-ping.ts --dry-run        # print payload, do not POST
 *   bun scripts/indexnow-ping.ts --url https://getcommit.dev/blog/foo  # ping single URL
 *
 * Per IndexNow spec: max 10,000 URLs per request. We chunk if needed.
 */

const HOST = "getcommit.dev";
const KEY = "db5e07761dea0e248ef94747c9ccd9ba";
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const ENDPOINT = "https://api.indexnow.org/IndexNow";
const SITE = `https://${HOST}`;
const MAX_BATCH = 10_000;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const includeNpm = args.has("--include-npm");

// --url <single-url> override (single-URL ping path)
let singleUrl: string | null = null;
{
  const idx = process.argv.indexOf("--url");
  if (idx > -1 && process.argv[idx + 1]) singleUrl = process.argv[idx + 1];
}

async function fetchSitemapUrls(sitemapPath: string): Promise<string[]> {
  const res = await fetch(`${SITE}${sitemapPath}`);
  if (!res.ok) {
    console.warn(`  sitemap fetch failed ${sitemapPath}: ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return urls;
}

async function verifyKeyServed(): Promise<boolean> {
  const res = await fetch(KEY_LOCATION);
  if (!res.ok) return false;
  const body = (await res.text()).trim();
  return body === KEY;
}

async function submit(urlList: string[]): Promise<{ ok: boolean; status: number; body: string }> {
  const payload = {
    host: HOST,
    key: KEY,
    keyLocation: KEY_LOCATION,
    urlList,
  };
  if (dryRun) {
    console.log("[dry-run] would POST:");
    console.log(JSON.stringify(payload, null, 2).slice(0, 800));
    if (JSON.stringify(payload).length > 800) console.log("…(truncated)");
    return { ok: true, status: 0, body: "dry-run" };
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { ok: res.ok || res.status === 202, status: res.status, body };
}

async function main() {
  console.log(`IndexNow ping → ${HOST}`);

  if (!dryRun) {
    const keyOk = await verifyKeyServed();
    if (!keyOk) {
      console.error(`✗ key file not served at ${KEY_LOCATION} — fix that first`);
      process.exit(1);
    }
    console.log(`✓ key verified at ${KEY_LOCATION}`);
  }

  // Single URL path (used by deploy when only one page changed)
  if (singleUrl) {
    if (!singleUrl.startsWith(SITE)) {
      console.error(`✗ url must be on ${SITE}: ${singleUrl}`);
      process.exit(1);
    }
    const result = await submit([singleUrl]);
    console.log(`  → ${result.status} ${result.body || "(empty)"}`);
    process.exit(result.ok ? 0 : 1);
  }

  // Bulk path: gather landing pages + blog
  const urls: string[] = [];
  console.log("Fetching sitemap-pages.xml…");
  urls.push(...(await fetchSitemapUrls("/sitemap-pages.xml")));
  console.log(`  ${urls.length} URLs`);

  console.log("Fetching sitemap-blog.xml…");
  const before = urls.length;
  urls.push(...(await fetchSitemapUrls("/sitemap-blog.xml")));
  console.log(`  +${urls.length - before} URLs`);

  // Package profile pages (116 static pages, SEO play)
  console.log("Fetching sitemap-package.xml…");
  const beforePkg = urls.length;
  urls.push(...(await fetchSitemapUrls("/sitemap-package.xml")));
  console.log(`  +${urls.length - beforePkg} URLs`);

  if (includeNpm) {
    console.log("Fetching sitemap-npm.xml…");
    const beforeNpm = urls.length;
    urls.push(...(await fetchSitemapUrls("/sitemap-npm.xml")));
    console.log(`  +${urls.length - beforeNpm} URLs`);
  }

  // Dedup
  const unique = [...new Set(urls)];
  console.log(`Total unique URLs: ${unique.length}`);

  if (unique.length === 0) {
    console.error("✗ no URLs to submit");
    process.exit(1);
  }

  // Chunk and submit
  let anyFailed = false;
  for (let i = 0; i < unique.length; i += MAX_BATCH) {
    const batch = unique.slice(i, i + MAX_BATCH);
    console.log(`Submitting batch ${Math.floor(i / MAX_BATCH) + 1} (${batch.length} URLs)…`);
    const result = await submit(batch);
    console.log(`  → ${result.status} ${result.body.slice(0, 200) || "(empty)"}`);
    if (!result.ok) anyFailed = true;
  }

  if (anyFailed) {
    console.error("✗ at least one batch failed");
    process.exit(1);
  }
  console.log("✓ IndexNow submission complete");
}

main().catch((err) => {
  console.error("✗ indexnow-ping failed:", err);
  process.exit(1);
});
