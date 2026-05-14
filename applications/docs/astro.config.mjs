// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { basePath } from './scripts/base-path.mjs';
import { remarkBasePath } from './scripts/remark-base-path.mjs';

export default defineConfig({
  site: 'https://sideline.majksa.net',
  base: basePath,
  trailingSlash: 'always',
  markdown: {
    remarkPlugins: [remarkBasePath()],
  },
  integrations: [
    starlight({
      title: 'Sideline Docs',
      logo: {
        src: './src/assets/logo.png',
        replacesTitle: false,
      },
      favicon: '/favicon.ico',
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'icon',
            type: 'image/png',
            sizes: '32x32',
            href: `${basePath}/favicon-32.png`,
          },
        },
      ],
      customCss: ['./src/styles/custom.css'],
      expressiveCode: {
        themes: ['github-dark-dimmed', 'github-light'],
      },
      defaultLocale: 'root',
      locales: {
        root: {
          label: 'English',
          lang: 'en',
        },
        cs: {
          label: 'Čeština',
          lang: 'cs',
        },
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/maxa-ondrej/sideline',
        },
      ],
      sidebar: [
        {
          label: 'Introduction',
          items: [{ autogenerate: { directory: 'introduction' } }],
        },
        {
          label: 'Quick start',
          items: [
            { label: 'For Players', slug: 'quick-start/players' },
            { label: 'For Captains', slug: 'quick-start/captains' },
            { label: 'For Admins', slug: 'quick-start/admins' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'RSVP to an event', slug: 'guides/rsvp-to-an-event' },
            { label: 'Manage your roster', slug: 'guides/manage-your-roster' },
            {
              label: 'Create recurring events',
              slug: 'guides/create-recurring-events',
            },
            { label: 'Invite members', slug: 'guides/invite-members' },
            {
              label: 'Discord integration',
              slug: 'guides/discord-integration',
            },
            { label: 'Notifications', slug: 'guides/notifications' },
            {
              label: 'Groups and rosters',
              slug: 'guides/groups-and-rosters',
            },
            {
              label: 'Calendar subscription (iCal)',
              slug: 'guides/calendar-subscription',
            },
          ],
        },
        {
          label: 'API Reference',
          items: [{ label: 'Overview', slug: 'api/overview' }],
        },
        { label: 'FAQ', slug: 'faq' },
        { label: 'Changelog', slug: 'changelog' },
        {
          label: 'About',
          items: [
            { label: 'Contact', slug: 'about/contact' },
            { label: 'Report a bug', slug: 'about/report-a-bug' },
            { label: 'Roadmap', slug: 'about/roadmap' },
          ],
        },
      ],
    }),
  ],
});
