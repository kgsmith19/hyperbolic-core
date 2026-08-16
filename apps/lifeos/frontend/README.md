# lifeos-ui

React SPA for the backend in `../backend/` (tailnet-only), signed in with Supabase Auth. Chat with
your data, browse and search the entity graph, capture new entities (including
daily check-ins) through schema-driven forms, read tomorrow's briefing, inspect
an entity's edges and full event history, approve or reject proposed dispute
drafts, and erase PII (`forget`).

Stack: React 19, TypeScript strict, Vite, Tailwind v4, TanStack Query,
React Router, Vitest + Testing Library, Playwright, oxlint + prettier.

## Quick start

Run commands from `frontend/`. Node 24+. Copy `.env.example` to `.env`; it holds only public-by-design values (`VITE_` vars are baked
into the client bundle — never put a secret here):

```
VITE_API_URL=                  # lifeos API base URL (tailnet)
VITE_SUPABASE_URL=             # Supabase project URL
VITE_SUPABASE_PUBLISHABLE_KEY= # Supabase publishable (anon) key
```

```
npm ci
npm run dev    # http://localhost:5173, sign in with the owner account
npm run lint && npm run test && npm run e2e && npm run build   # full gate
```

## Documentation

See [AGENTS.md](AGENTS.md) for application guidance and `../AGENTS.md` for the root PR Gate and delivery flow.
