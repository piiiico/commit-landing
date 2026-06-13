#!/usr/bin/env bun
/**
 * Build-time script: fetch trust scores for top 100 npm packages
 * Saves results to src/data/rankings.json
 * Run before building the site: bun scripts/generate-rankings.ts
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

const API = 'https://poc-backend.amdal-dev.workers.dev/api/audit';
const NPM_DOWNLOADS_API = 'https://api.npmjs.org/downloads/point/last-week';
const API_KEY = process.env.COMMIT_API_KEY || '';

// Top 100 npm packages by weekly downloads (curated from npm stats)
const TOP_PACKAGES = [
  // ── Utility / core (high-download, often single-publisher) ──
  'tslib', 'lodash', 'chalk', 'semver', 'debug', 'minimist', 'commander',
  'yargs', 'dotenv', 'uuid', 'ms', 'glob', 'rimraf', 'mkdirp', 'fs-extra',
  'cross-env', 'which', 'once', 'inherits', 'readable-stream',
  'minimatch', 'lru-cache', 'ansi-styles', 'strip-ansi', 'supports-color',
  'color-convert', 'color-name', 'has-flag', 'escape-string-regexp',
  'string-width', 'wrap-ansi', 'p-limit', 'p-locate', 'locate-path',
  'yallist', 'signal-exit', 'is-glob', 'picomatch', 'glob-parent',
  'fill-range', 'braces', 'micromatch', 'fast-glob', 'chokidar',
  'json-schema-traverse', 'source-map', 'graceful-fs',
  'safe-buffer', 'string_decoder', 'isarray',

  // ── TypeScript / types ──
  'typescript', '@types/node', '@types/react', '@types/react-dom',

  // ── HTTP / networking ──
  'axios', 'node-fetch', 'got', 'superagent', 'request', 'ws',
  'undici', 'http-proxy-agent', 'https-proxy-agent', 'agent-base',

  // ── Bundlers / build ──
  'webpack', 'esbuild', 'vite', 'rollup', 'parcel', 'turbo',
  'postcss', 'autoprefixer', 'tailwindcss', 'sass', 'less',
  '@babel/core', '@babel/preset-env', '@babel/preset-react',
  '@swc/core', 'terser',

  // ── Testing ──
  'jest', 'mocha', 'chai', 'sinon', 'vitest', 'supertest',
  'cypress', 'playwright', '@testing-library/react', '@testing-library/jest-dom',

  // ── Linting / formatting ──
  'eslint', 'prettier', 'typescript-eslint', 'stylelint',

  // ── Frontend frameworks ──
  'react', 'react-dom', 'vue', 'next', '@angular/core', 'svelte',
  'preact', 'solid-js', 'lit', '@angular/cli',

  // ── State management ──
  'redux', '@reduxjs/toolkit', 'mobx', 'zustand', 'recoil', 'jotai',

  // ── Routing ──
  'react-router', 'react-router-dom', '@tanstack/react-router',

  // ── Backend / servers ──
  'express', 'fastify', 'koa', 'hapi', 'nestjs',
  '@nestjs/core', '@nestjs/common', 'socket.io',

  // ── Auth / security ──
  'jsonwebtoken', 'bcrypt', 'helmet', 'passport',
  'jose', 'node-forge',

  // ── Databases / ORMs ──
  'mongoose', 'sequelize', 'knex', 'prisma', 'typeorm',
  'pg', 'mysql2', 'redis', 'ioredis', 'better-sqlite3', 'drizzle-orm',

  // ── Date / time ──
  'moment', 'date-fns', 'dayjs', 'luxon',

  // ── Schema validation ──
  'joi', 'yup', 'zod', 'ajv', 'class-validator',

  // ── Logging ──
  'winston', 'pino', 'morgan', 'bunyan', 'log4js',

  // ── AWS / Cloud ──
  '@aws-sdk/client-s3', 'firebase', '@google-cloud/storage',
  'aws-sdk',

  // ── Process / CLI ──
  'pm2', 'nodemon', 'concurrently', 'cross-spawn',
  'execa', 'ora', 'inquirer', 'chalk-animation',

  // ── File processing ──
  'sharp', 'multer', 'archiver', 'unzipper',
  'csv-parser', 'papaparse', 'xlsx',

  // ── Data ──
  'rxjs', 'immer', 'ramda', 'underscore', 'lodash-es',

  // ── Misc utilities ──
  'async', 'bluebird', 'q', 'form-data', 'qs', 'body-parser',
  'cors', 'cookie-parser', 'compression', 'serve-static',
  'cheerio', 'puppeteer', 'jsdom',

  // ── Template engines ──
  'handlebars', 'ejs', 'pug',

  // ── Crypto ──
  'crypto-js', 'bcryptjs', 'tweetnacl',

  // ── GraphQL ──
  'graphql', '@apollo/client', '@apollo/server',

  // ── Testing utilities ──
  'nock', 'jest-mock',

  // ── AI SDKs (growing fast, high profile) ──
  'hono', 'openai', '@anthropic-ai/sdk',

  // ── Agent infrastructure ──
  'ai', '@ai-sdk/openai', '@ai-sdk/anthropic',
  '@modelcontextprotocol/sdk',
  'langchain', '@langchain/core', '@langchain/openai',
  'llamaindex', 'x402',

  // ── Supply chain attack targets (recently compromised or structurally similar) ──
  'node-ipc', 'ua-parser-js', 'event-stream', 'coa', 'rc',
];

interface AuditResult {
  name: string;
  ecosystem: string;
  score: number;
  maintainers: number;
  weeklyDownloads: number;
  ageYears: number;
  trend: string;
  daysSinceLastPublish: number;
  riskFlags: string[];
  scoreBreakdown: {
    longevity: number;
    downloadMomentum: number;
    releaseConsistency: number;
    maintainerDepth: number;
    githubBacking: number;
  };
}

function getRiskLevel(flags: string[]): string {
  // Flags now include descriptions, e.g. "CRITICAL: sole npm publisher + >10M/wk"
  if (flags.some(f => f.startsWith('CRITICAL'))) return 'CRITICAL';
  if (flags.some(f => f.startsWith('HIGH'))) return 'HIGH';
  if (flags.some(f => f.startsWith('MODERATE'))) return 'MODERATE';
  if (flags.some(f => f.startsWith('LOW'))) return 'LOW';
  if (flags.some(f => f.startsWith('WARN'))) return 'SAFE'; // WARN is still SAFE
  return 'SAFE';
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchBatch(packages: string[], retries = 3): Promise<AuditResult[]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
      const res = await fetch(API, {
        method: 'POST',
        headers,
        body: JSON.stringify({ packages, ecosystem: 'npm' }),
      });
      if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
      }
      const data = await res.json() as { count: number; results: AuditResult[] };
      return data.results;
    } catch (e) {
      if (attempt < retries) {
        console.error(`  Attempt ${attempt}/${retries} failed: ${e}. Retrying in ${attempt * 2}s...`);
        await sleep(attempt * 2000);
      } else {
        console.error(`  All ${retries} attempts failed: ${e}`);
        return [];
      }
    }
  }
  return [];
}

/**
 * Fallback: fetch weekly downloads directly from npm API
 * Used when audit API returns 0 for a package (likely CF rate limit issue)
 */
async function fetchNpmDownloadsDirect(packageName: string): Promise<number> {
  try {
    const encodedName = encodeURIComponent(packageName).replace(/^%40/, '@');
    const res = await fetch(`${NPM_DOWNLOADS_API}/${encodedName}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return 0;
    const data = await res.json() as { downloads: number; package: string };
    return data.downloads ?? 0;
  } catch {
    return 0;
  }
}

/**
 * For packages with 0 weeklyDownloads, fetch the real number directly from npm.
 * The audit API sometimes returns 0 due to CF-side rate limiting of the npm downloads API.
 */
async function fixZeroDownloads(results: AuditResult[]): Promise<AuditResult[]> {
  const zeroPackages = results.filter(r => r.weeklyDownloads === 0);
  if (zeroPackages.length === 0) return results;

  console.log(`\nFixing ${zeroPackages.length} packages with 0 downloads via npm API directly...`);

  const fixed = [...results];
  for (const pkg of zeroPackages) {
    const downloads = await fetchNpmDownloadsDirect(pkg.name);
    if (downloads > 0) {
      const idx = fixed.findIndex(r => r.name === pkg.name);
      if (idx !== -1) {
        fixed[idx] = { ...fixed[idx], weeklyDownloads: downloads };
        console.log(`  ${pkg.name}: 0 → ${downloads.toLocaleString()}`);
      }
    } else {
      console.log(`  ${pkg.name}: still 0 (not on npm or truly 0)`);
    }
    await sleep(100); // gentle rate limiting
  }

  return fixed;
}

async function main() {
  console.log(`Fetching trust scores for ${TOP_PACKAGES.length} packages...`);

  const allResults: AuditResult[] = [];
  const failedPackages: string[] = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < TOP_PACKAGES.length; i += BATCH_SIZE) {
    const batch = TOP_PACKAGES.slice(i, i + BATCH_SIZE);
    console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(TOP_PACKAGES.length / BATCH_SIZE)}: ${batch.join(', ')}`);

    const results = await fetchBatch(batch);
    if (results.length === 0) {
      console.error(`  Batch completely failed, packages will be missing`);
      failedPackages.push(...batch);
    } else {
      allResults.push(...results);
      const zeroCount = results.filter(r => r.weeklyDownloads === 0).length;
      if (zeroCount > 0) {
        console.log(`  Got ${results.length} results (${zeroCount} with 0 downloads — will fix)`);
      } else {
        console.log(`  Got ${results.length} results`);
      }
    }

    if (i + BATCH_SIZE < TOP_PACKAGES.length) {
      await sleep(1000);
    }
  }

  // Fix packages that got 0 from audit API by querying npm directly
  const fixedResults = await fixZeroDownloads(allResults);

  // Sort by weekly downloads descending, then assign rank
  const sorted = fixedResults
    .sort((a, b) => b.weeklyDownloads - a.weeklyDownloads)
    .map((pkg, idx) => ({
      rank: idx + 1,
      name: pkg.name,
      weeklyDownloads: pkg.weeklyDownloads,
      score: pkg.score,
      riskLevel: getRiskLevel(pkg.riskFlags),
      riskFlags: pkg.riskFlags,
      maintainers: pkg.maintainers,
      ageYears: Math.round(pkg.ageYears * 10) / 10,
      trend: pkg.trend,
      daysSinceLastPublish: pkg.daysSinceLastPublish,
    }));

  // Validation: warn if >5% of packages still have 0 downloads after fix
  const zeroDownloadPackages = sorted.filter(p => p.weeklyDownloads === 0);
  const zeroPercent = (zeroDownloadPackages.length / sorted.length) * 100;
  if (zeroDownloadPackages.length > 0) {
    console.warn(`\nVALIDATION WARNING: ${zeroDownloadPackages.length} packages (${zeroPercent.toFixed(1)}%) still have 0 weekly downloads:`);
    console.warn(zeroDownloadPackages.map(p => p.name).join(', '));
    if (zeroPercent > 5) {
      console.error(`VALIDATION FAILED: More than 5% of packages (${zeroPercent.toFixed(1)}%) have 0 downloads after npm fallback!`);
    }
  }

  if (failedPackages.length > 0) {
    console.error(`\nFailed packages (not in output): ${failedPackages.join(', ')}`);
  }

  // Compute summary stats
  const stats = {
    total: sorted.length,
    critical: sorted.filter(p => p.riskLevel === 'CRITICAL').length,
    safe: sorted.filter(p => p.riskLevel === 'SAFE').length,
    high: sorted.filter(p => p.riskLevel === 'HIGH').length,
    moderate: sorted.filter(p => p.riskLevel === 'MODERATE').length,
    totalWeeklyDownloads: sorted.reduce((sum, p) => sum + p.weeklyDownloads, 0),
    generatedAt: new Date().toISOString(),
  };

  const output = { stats, packages: sorted };

  // Write to src/data/
  const outPath = join(import.meta.dir, '..', 'src', 'data', 'rankings.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log('\n=== Summary ===');
  console.log(`Total packages: ${stats.total}`);
  console.log(`CRITICAL: ${stats.critical}`);
  console.log(`HIGH: ${stats.high}`);
  console.log(`MODERATE: ${stats.moderate}`);
  console.log(`SAFE: ${stats.safe}`);
  console.log(`Total weekly downloads: ${(stats.totalWeeklyDownloads / 1e9).toFixed(1)}B`);
  console.log(`Zero-download packages: ${zeroDownloadPackages.length}`);
  console.log(`\nSaved to ${outPath}`);
}

main().catch(console.error);
