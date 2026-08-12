# ADR-0003: Hosting and deployment — GitHub Pages, BUILD

## Context

Every product requirement current as of `v0.1.14` shipped by 2026-08-08. `web/index.html` has never been served from anything other than `python3 -m http.server 8812` on a developer laptop. Issue #12 asked for an explicit shape decision before any deployment work starts.

The constraints that must survive the hosting choice (from `AGENTS.md`, `docs/SYSTEM-REQUIREMENTS.md`):

- **SR-02** — No application server. The page talks directly to Supabase's own PostgREST and GoTrue.
- **SR-03** — One static HTML file; zero dependencies, zero build step.
- **SR-07** — Only the anon key is in the repo; it is public by design. The service-role key never appears anywhere.
- **SR-08 / NFR-011** — Prompt bodies reach only the Supabase project. The page's two `fetch` targets are both the Supabase project.
- **SR-15** — Marginal infrastructure cost is $0.
- **SR-05..SR-06 (NFR-003/NFR-004)** — RLS and row-ownership are the security boundary, not the page's origin.

## Options compared

### Option A — GitHub Pages (free tier, static, no repo build step)

| Consideration | Detail |
|---|---|
| Hosting model | Serves static files with a Pages deploy build on push; no application build step, no server, no new dependency |
| Cost | $0, within free tier |
| SR-03 compliance | Full — one static file, no build step, no `package.json` needed |
| SR-15 compliance | Full |
| Custom domain | Supported; `kgsmith19.github.io/prompt-organizer` works immediately without one |
| HTTPS | Automatic; enforced |
| Deployment | Push to `main` (or a `gh-pages` branch) triggers Pages build in seconds |
| CI integration | `node --test "tests/*.test.mjs"` already runs; one extra workflow step to enable deployment on green |

### Option B — Vercel

| Consideration | Detail |
|---|---|
| Hosting model | Static file deployment, but wraps the deploy in Vercel's own CI/CD and edge network |
| Cost | $0 on hobby tier |
| SR-03 compliance | Full in principle, but Vercel's deploy pipeline can silently inject build steps; a misconfiguration risk |
| Dependencies introduced | Vercel account, Vercel-specific `vercel.json` config, token secret in GitHub Actions |
| SR-07 risk | A Vercel secret (deploy token) would enter the GitHub Actions environment — not the service-role key, but an additional secret surface to manage |
| Advantage over A | None for this repo's actual constraints |

### Option C — Cloudflare Pages

| Consideration | Detail |
|---|---|
| Hosting model | Similar to Vercel; static files served from Cloudflare's edge |
| Cost | $0 on free tier |
| SR-03 compliance | Full in principle |
| Dependencies introduced | Cloudflare account, Wrangler config or Cloudflare-specific pipeline, additional secret surface |
| Advantage over A | None that matters here — this app doesn't need a CDN edge layer |

### Option D — Local-only (status quo)

| Consideration | Detail |
|---|---|
| Availability | Zero external availability; Kyle must run `python3 -m http.server 8812` to use it |
| `U-002` impact | The `render_prompt` RPC (FR-013) is already live and callable directly via `curl` / `fetch` from any authenticated caller; the *page* being local-only does not block `U-002`'s API path, but it prevents real casual use |
| Verdict | Acceptable indefinitely for internal use; blocks any future use beyond Kyle's laptop |

## Does real hosting change the security posture?

**No.** The security model does not change when the page moves from `localhost` to a public URL.

- **SR-05 / NFR-003** — RLS is enforced at the Postgres level. An attacker who fetches `index.html` from a public URL cannot read or write anyone else's prompts; they still need a valid `Authorization` JWT that Supabase's GoTrue minted for the correct `user_id`. The page's origin is irrelevant to this check.
- **SR-07 / NFR-004** — The anon key is already in the source file and was already public by design (it is safe to ship in browser code because RLS is the boundary). Publishing the page does not make it more exposed; it was already committed to a public repo.
- **SR-08 / NFR-011** — The page's two `fetch` targets are both the Supabase project URL. Publishing the HTML does not add a third target. An attacker cannot redirect those `fetch` calls without modifying the served HTML itself (which requires repo access, not just page access).
- **FR-013 / `U-002`** — `render_prompt` requires an authenticated JWT and is `security invoker`. A new external caller (`U-002`) already works today via direct RPC call, with or without the page being hosted. Moving the page to GitHub Pages does not weaken or strengthen this surface.

The one meaningful surface change: the page becomes reachable by anyone with the URL, enabling someone to bring their own Supabase credentials and use the UI against a different project. This is acceptable because the UI's `fetch` targets are hardcoded to this project's Supabase URL; a visitor without a valid JWT for `woltgcggxaehtuypkxqk` sees only 401s. The UI is not multi-tenant and does not need to be.

## Decision

**BUILD — deploy `web/index.html` to GitHub Pages.**

Option A satisfies every constraint (SR-02, SR-03, SR-07, SR-08, SR-15) with the smallest possible surface: no new account, no new secret, no new dependency, no application build step. The security posture does not change. The status quo (Option D) becomes unnecessary friction once the existing product requirements are complete.

## Smallest first slice

A single GitHub Actions workflow file (`.github/workflows/pages.yml`) that:
1. Runs `node --test "tests/*.test.mjs"` (existing CI gate).
2. On green, packages `web/` with `actions/upload-pages-artifact` and then deploys it with `actions/deploy-pages`.
3. Triggers on push to `main`.

No changes to `web/index.html`, no application build step, no new file in `web/`.

## Consequences

- `web/index.html` is reachable at a stable public URL (initially `https://kgsmith19.github.io/prompt-organizer/`).
- A custom domain can be added later with a `CNAME` entry; no re-architecture needed.
- `U-002`'s agent caller can use the same RPC endpoint it uses today; the page move does not affect it.
- The `python3 -m http.server 8812` command remains valid for local development.
- A future requirement that changes the two `fetch` targets (e.g. multi-project support) would revisit SR-08; this ADR does not block that.
