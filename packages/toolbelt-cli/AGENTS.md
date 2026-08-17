# AGENTS.md

## 🎯 Purpose

`@hyperbolic/toolbelt-cli` is the scaffold CLI for the Toolbelt three-step new-tool lifecycle (TB-3, `docs/planning/05-c-toolbelt.md` section 5.1). It is a private workspace package.

## 📋 Product Boundaries

- Scaffolding output must stay in step with what `apps/toolbelt` actually expects. A change to the tool layout there is a change here.
- Generated scaffolds are a starting point, not a managed artifact; this CLI does not own files after it writes them.
- Make the smallest clear change that completely resolves its linked GitHub Issue.
- Preserve behavior-focused tests; never weaken assertions to make a gate pass.

## ⚙️ Commands

```bash
npm test          # node --test "tests/*.test.mjs"
npm run tool:new  # scaffold a new tool
```

## ✅ Completion Criteria

GitHub Issues are the durable work source. A change is ready when its linked Issue's acceptance criteria are satisfied, the commands above pass, and the root's `Verify: Tests (Linux)` gate succeeds — it covers `packages/**`.

## 🔒 Collaboration Boundary

AI coding agents may create assigned branches, commits, Issues, and pull requests. They must not submit reviews, approve or block pull requests, request reviewers, or post unsolicited comments. They may answer in an Issue or pull request only when explicitly tagged with a direct question.
