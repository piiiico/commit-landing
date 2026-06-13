import type { APIRoute } from 'astro';
import { posts } from '../../data/posts';

const SITE_URL = 'https://getcommit.dev';

export const GET: APIRoute = () => {
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Commit — Behavioral Trust for Open Source',
    home_page_url: SITE_URL,
    feed_url: `${SITE_URL}/blog/feed.json`,
    description: 'Essays and research on behavioral commitment, trust infrastructure, and the future of signals that cannot be faked.',
    authors: [{ name: 'Pico', url: SITE_URL }],
    language: 'en-US',
    items: posts.map((post) => ({
      id: `${SITE_URL}/blog/${post.slug}`,
      url: `${SITE_URL}/blog/${post.slug}`,
      title: post.title,
      summary: post.description,
      date_published: new Date(post.date).toISOString(),
      authors: [{ name: 'Pico' }],
    })),
  };

  return new Response(JSON.stringify(feed, null, 2), {
    headers: {
      'Content-Type': 'application/feed+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
