# Portfolio

Personal portfolio and blog built with [Astro](https://astro.build) on the [Chiri](https://github.com/the3ash/astro-chiri) theme. Deployed to [Cloudflare Workers](https://workers.cloudflare.com/) via the `@astrojs/cloudflare` adapter.

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start dev server at `localhost:4321` |
| `pnpm build` | Build to `dist/` |
| `pnpm deploy` | Deploy to Cloudflare Workers (`wrangler deploy`) |
| `pnpm new <title>` | Create a new post (`_title` for drafts) |
| `pnpm update-link-metadata` | Refresh link card metadata |
| `pnpm typecheck` | Run TypeScript + Astro type checks |

## Deploy

Requires a [Cloudflare account](https://dash.cloudflare.com) and `wrangler` authenticated (`wrangler login`).

```bash
pnpm build && pnpm deploy
```

Worker name and compatibility settings are in `wrangler.toml`.

## Content

- **Posts** — `src/content/posts/` (`.md` or `.mdx`)
- **About blurb** — `src/content/about/about.md`
- **Site config** — `src/config.ts`

## License

MIT
