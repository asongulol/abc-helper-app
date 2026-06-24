import fs from 'node:fs';
import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// `showLastUpdate*` reads git history per file; build hosts that deploy without a
// .git worktree (e.g. Vercel CLI uploads) throw "outside any Git worktree". Enable
// it only when a .git dir is present (local + git-based deploys). cwd is website/.
const repoHasGit = fs.existsSync('../.git');

const config: Config = {
  title: 'ABC Helper Docs',
  tagline: 'Payroll pipeline & contractor portal — runbooks, specs, conformance',
  favicon: 'img/favicon.ico',

  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Update to your real Vercel domain once assigned (affects canonical URLs /
  // sitemap only; served at the domain root so baseUrl stays '/').
  url: 'https://abc-helper-app-docs.vercel.app',
  baseUrl: '/',

  organizationName: 'asongulol',
  projectName: 'abc-helper-app',

  // The repo docs are plain markdown that cross-link to source paths; warn (don't
  // throw) on links that don't resolve to a Docusaurus route.
  onBrokenLinks: 'warn',

  // Parse `.md` as CommonMark (not strict MDX) so existing docs with raw `<`/`{`
  // don't fail to compile. `.mdx` files still get full MDX.
  markdown: {
    format: 'detect',
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          // Serve the repo's existing docs/ folder as the site (docs-only mode).
          path: '../docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/asongulol/abc-helper-app/tree/main/docs/',
          showLastUpdateTime: repoHasGit,
          showLastUpdateAuthor: repoHasGit,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    '@docusaurus/theme-mermaid',
    'docusaurus-theme-openapi-docs',
    // Offline full-text search (no Algolia/account); index built at production build.
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        docsRouteBasePath: '/',
      },
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // Add as docs move, e.g. { from: '/old-slug', to: '/CUTOVER-RUNBOOK' }
        redirects: [],
      },
    ],
    // Separate "Reference" docs instance (route /reference) that holds the
    // generated OpenAPI + TypeDoc output — keeps the hand-written docs/ pristine.
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'reference',
        path: 'reference',
        routeBasePath: 'reference',
        sidebarPath: './sidebarsReference.ts',
      },
    ],
    // Code reference generated from the app's TypeScript lib (extend entryPoints
    // as more modules are worth publishing).
    [
      'docusaurus-plugin-typedoc',
      {
        entryPoints: ['../src/lib/format.ts'],
        // Scoped tsconfig (not the app root) so TypeDoc only compiles the entry
        // points — the docs build doesn't install the app's React deps.
        tsconfig: './tsconfig.typedoc.json',
        out: 'reference/code',
        readme: 'none',
        skipErrorChecking: true,
      },
    ],
    // API reference generated from the OpenAPI spec into the reference tree.
    // Regenerate with: pnpm -C website docusaurus gen-api-docs all
    [
      'docusaurus-plugin-openapi-docs',
      {
        id: 'openapi',
        docsPluginId: 'reference',
        config: {
          abcApi: {
            specPath: 'openapi/abc-api.yaml',
            outputDir: 'reference/api',
            sidebarOptions: { groupPathsBy: 'tag', categoryLinkSource: 'tag' },
          },
        },
      },
    ],
  ],

  themeConfig: {
    image: 'img/docusaurus-social-card.jpg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'ABC Helper Docs',
      logo: {
        alt: 'ABC Helper',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'docSidebar',
          sidebarId: 'referenceSidebar',
          docsPluginId: 'reference',
          position: 'left',
          label: 'Reference',
        },
        {
          href: 'https://github.com/asongulol/abc-helper-app',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [{ label: 'Home', to: '/' }],
        },
        {
          title: 'Project',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/asongulol/abc-helper-app',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} ABC Helper. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
