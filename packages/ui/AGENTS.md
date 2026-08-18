# AGENTS.md

## 🎯 Purpose

`@hyperbolic/ui` holds the shared design tokens, primitives, and state components used by every `hyperbolic-core` zone. It is a private workspace package and is built before it is consumed.

## 📋 Product Boundaries

- A bundle-size budget is enforced by `test/size-check.mjs` and runs as part of `npm test`. Treat a budget failure as a real failure, not a threshold to raise.
- Tokens and primitives are shared surface: a breaking change here lands in every zone at once.
- `npm run build` must be run before consumers can resolve the built output.
- Make the smallest clear change that completely resolves its linked GitHub Issue.
- Preserve behavior-focused tests; never weaken assertions to make a gate pass.

## ⚙️ Commands

```bash
npm run build  # vite build && tsc --emitDeclarationOnly --outDir dist
npm test       # node --test 'test/**/*.test.mjs' && node test/size-check.mjs
```

## ✅ Completion Criteria

GitHub Issues are the durable work source. A change is ready when its linked Issue's acceptance criteria are satisfied, the commands above pass, and the root's `Platform` gate succeeds — it covers `packages/**`.

## 🔒 Collaboration Boundary

AI coding agents may create assigned branches, commits, Issues, and pull requests. They must not submit reviews, approve or block pull requests, request reviewers, or post unsolicited comments. They may answer in an Issue or pull request only when explicitly tagged with a direct question.
