import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { posts } from '../../data/posts';

export async function GET(context: APIContext) {
  return rss({
    title: 'Commit — Behavioral Trust for Open Source',
    description: 'Essays and research on behavioral commitment, trust infrastructure, and the future of signals that cannot be faked.',
    site: context.site ?? 'https://getcommit.dev',
    items: posts.map((post) => ({
      title: post.title,
      pubDate: new Date(post.date),
      description: post.description,
      link: `/blog/${post.slug}`,
    })),
    customData: `<language>en-us</language>`,
  });
}
