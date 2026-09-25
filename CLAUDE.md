# Portfolio — CLAUDE.md

## Project Overview

Personal portfolio/blog built on the **Chiri** Astro theme. Static site with MDX support, deployed as a Cloudflare Worker named `portfolio`.

- **Framework**: Astro 6 (TypeScript)
- **Package manager**: `pnpm` (workspace setup via `pnpm-workspace.yaml`)
- **Deployment**: Cloudflare Workers Builds, connected to this GitHub repo. A push to
  `main` builds and deploys to evanyoung.dev. Any other pushed branch only uploads a
  preview version (`wrangler versions upload`) and does not go live. Don't deploy by
  hand from a local checkout — see `docs/build.md`.

## Key Files

| File                               | Purpose                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `src/config.ts`                    | All site/theme configuration (title, author, feature flags)            |
| `src/content/about/about.md`       | About blurb shown at top of index page                                 |
| `src/content/posts/`               | Blog posts (`.md` or `.mdx`)                                           |
| `src/content.config.ts`            | Astro content collection schemas                                       |
| `src/data/link-card-metadata.json` | Cached link card metadata (auto-updated)                               |
| `src/data/tools.ts`                | The `/tools` page — the only index of the tools on tools.evanyoung.dev |

## Common Commands

```bash
pnpm dev                    # Start dev server (also refreshes link metadata)
pnpm build                  # Typecheck + build (outputs to dist/)
pnpm new <title>            # Create a new post
pnpm new _<title>           # Create a draft post (prefixed with _)
pnpm update-link-metadata   # Re-fetch link card metadata
pnpm update-theme           # Pull latest theme updates
pnpm lint                   # ESLint
pnpm format                 # Prettier
```

## Content Authoring

### New Posts

Posts live in `src/content/posts/`. Required frontmatter:

```yaml
---
title: Post Title
pubDate: 'YYYY-MM-DD'
image: optional-image.webp # optional
---
```

Drafts: prefix filename with `_` (e.g., `_draft-example.md`). The `pnpm new _title` script handles this.

### About Page

Edit `src/content/about/about.md` — content appears at the top of the index.

### MDX

`.mdx` files are supported. Example components are in `src/components/examples/`.

## Architecture

```
src/
  components/
    examples/    # Reusable MDX components (Callout, Tag, CounterButton)
    layout/      # Page shell (BaseHead, Header, Footer, TransitionWrapper)
    ui/          # Feature components (ImageViewer, TOC, LinkCard, GitHubCard, etc.)
    widgets/     # Data-driven pieces (PostList, FormattedDate, About)
  content/
    about/       # About section markdown
    posts/       # Blog posts + _assets/
  layouts/       # BaseLayout, IndexLayout, PostLayout
  pages/         # Astro routes
  plugins/       # Custom remark/rehype plugins
  styles/        # global.css, post.css, fonts.css
  types/         # TypeScript interfaces
  utils/         # Helpers (date, feed, image-config, draft)
```

## Custom Plugins (src/plugins/)

- `remark-content-features` — custom directives (callouts, etc.)
- `remark-embedded-media` — YouTube/video embeds
- `remark-toc` — auto table of contents
- `remark-reading-time` — reading time estimate
- `rehype-image-processor` — image optimization helpers
- `rehype-copy-code` — copy button injection for code blocks
- `rehype-cleanup` — post-processing cleanup

## Theming

- Light/dark mode via CSS variables; `ThemeManager.astro` + `ThemeToggle.astro`
- Syntax highlighting uses `css-variables` Shiki theme (inherits from CSS)
- Fonts: Inter, Besley Italic, Noto Sans SC (served from `public/fonts/`)

## Linting & Formatting

- ESLint with `eslint-plugin-astro` and TypeScript rules (`eslint.config.js`)
- Prettier with `prettier-plugin-astro` (`.prettierrc`)
- Full typecheck: `pnpm typecheck` runs both `tsc --noEmit` and `astro check`
