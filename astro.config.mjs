import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://getcommit.dev',
  output: 'static',
  // Cloudflare Pages 308-redirects no-slash → slash for static assets.
  // Aligning Astro link/path generation with the served URL prevents the
  // canonical/redirect mismatch that kept ~78 marketing+blog pages out of
  // Google's index ("Crawled — not indexed"). Diagnosed 2026-05-23.
  trailingSlash: 'always',
  build: {
    assets: '_assets',
  },
  redirects: {
    '/register': '/get-started',
    // Note: /signup is handled by src/pages/signup.astro (JS redirect that
    // preserves ?ref=… query string — Astro's static-redirect map can't do
    // that). Keeping the legacy URL alive for old Commit MCP soft-CTA links.
    '/blog/agents-can-pay': 'https://agentlair.dev/blog/agents-can-pay',
    '/blog/building-on-visa-tap': 'https://agentlair.dev/blog/building-on-visa-tap',
    '/blog/mastercard-vi-l4-gap': 'https://agentlair.dev/blog/mastercard-vi-l4-gap',
    '/blog/rsac-2026-confirmed-the-gap': 'https://agentlair.dev/blog/rsac-2026-confirmed-the-gap',
    '/blog/the-agent-passed-all-the-checks': 'https://agentlair.dev/blog/the-agent-passed-all-the-checks',
    '/blog/who-decides-what-agents-can-buy': 'https://agentlair.dev/blog/who-decides-what-agents-can-buy',
    '/blog/135000-frameworks-zero-governance': 'https://agentlair.dev/blog/135000-frameworks-zero-governance',
    '/blog/litellm-supply-chain-mcp': 'https://agentlair.dev/blog/litellm-supply-chain-mcp',
    '/blog/claude-code-source-leak-fake-repos': 'https://agentlair.dev/blog/claude-code-source-leak-fake-repos',
    '/blog/claude-code-behavioral-telemetry': 'https://agentlair.dev/blog/claude-code-behavioral-telemetry',
    '/blog/emdash-trust-guard': 'https://agentlair.dev/blog/emdash-trust-guard',
'/blog/behavioral-trust-without-surveillance': 'https://agentlair.dev/blog/behavioral-trust-without-surveillance',
    '/blog/quantum-deadline-agent-credentials': 'https://agentlair.dev/blog/quantum-deadline-agent-credentials',
    '/blog/sixty-percent-want-approval-gates': 'https://agentlair.dev/blog/sixty-percent-want-approval-gates',
  },
});
