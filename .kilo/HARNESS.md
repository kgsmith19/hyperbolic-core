# Kilo Harness Configuration for hyperbolic-core

**Status:** Ready for use  
**Target:** Primary coding harness for hyperbolic-core development  
**Foundation:** AES (`kgsmith19/agent-engineering-standard`) + Kilo CLI  
**Extensions:** `kgsmith19/agent-extensions` (submodule)

---

## Quick Start

1. **Initialize the Kilo harness in hyperbolic-core:**
   ```bash
   cd hyperbolic-core
   git submodule init && git submodule update
   ```

2. **Start Kilo as the dev agent:**
   ```bash
   kilo                 # Default agent is 'dev' (primary harness mode)
   ```

3. **Check current model and provider:**
   ```bash
   /roles               # Displays dev and review model config from agent-roles.yaml
   ```

4. **Begin work per AES:**
   - Create or claim a thin Issue
   - Create a worktree: `git worktree add .worktrees/issue-N-slug -b issue/N-slug`
   - Implement, test (TDD), commit, PR
   - Respond to AI Review findings
   - Merge when PR Gate passes

---

## Architecture

### Three Core Components

**1. `/agent-roles.yaml` — Single Source of Truth**

- Declares `dev.provider`, `dev.model`, `review.provider`, `review.model`
- Human-readable YAML (no templating, no secrets)
- Committed to git
- Read by Kilo at initialization and by GitHub Actions workflows
- Change it once, all consumers (Kilo, Actions, reviewers) pick it up

**2. `/kilo.json` — Kilo Runtime Config**

- Model defaults (mapped from `agent-roles.yaml`)
- Permission rules for dev/reviewer agents
- Skill paths (agent-extensions plugins)
- MCP definitions (disabled by default, enable on demand)

**3. `.kilo/agent/` and `.kilo/command/` — Agent & Command Definitions**

- `dev.md`: Implementation agent system prompt + frontmatter
- `reviewer.md`: Independent reviewer system prompt + frontmatter
- `command/role-set.md`, `command/roles-show.md`, `command/roles-sync.md`: Role management CLI commands

---

## Roles

### dev (Primary Implementation Agent)

| Property | Value |
|----------|-------|
| Mode | `primary` |
| Model | From `agent-roles.yaml` → `dev.model` |
| GitHub App | `hyperbolic-core-dev` |
| Responsibilities | Write code, create PRs, respond to reviews, merge when ready |
| Permissions | Broad: bash, edit (apps/packages/services/.github/config), read, glob, grep, task |

**When to use:** Every development task (feature, bugfix, refactor, documentation)

### reviewer (Independent LLM Review)

| Property | Value |
|----------|-------|
| Mode | `subagent` |
| Model | From `agent-roles.yaml` → `review.model` |
| GitHub App | `hyperbolic-core-reviewer` |
| Responsibilities | Evaluate PRs, report findings, block/allow merge |
| Permissions | Read-only + task (no direct edits, only comments/findings) |
| Invariant | Provider family MUST differ from `dev` |

**When to use:** PR review gate (triggered by AI Review workflow; usually not manual)

---

## Changing Models

### Method 1: Direct YAML Edit

Edit `/agent-roles.yaml`:
```yaml
dev:
  provider: openai                  # Change provider
  model: gpt-4o                     # Change model
  github_app: hyperbolic-core-dev

review:
  provider: anthropic               # Keep reviewer independent
  model: claude-opus-4-20250514
  github_app: hyperbolic-core-reviewer
```

Commit and push. Next Kilo session and next PR workflow automatically use the new config.

### Method 2: Kilo CLI Command

```bash
/role set dev openai gpt-4o
```

This command:
- Reads the current `agent-roles.yaml`
- Validates the provider (anthropic | openai | gemini)
- Edits the file in-place
- Validates provider separation (review ≠ dev family)
- Reloads Kilo agents

### Method 3: Kilo `/models` Command

```bash
/models                 # Interactive model picker for current agent
```

(Standard Kilo command; persists to `kilo.json` for this session only, not persisted to `agent-roles.yaml`)

### Verifying Changes

```bash
/roles                  # Display current agent-roles.yaml
```

Expected output:
```
dev:
  provider: openai
  model: gpt-4o

review:
  provider: anthropic
  model: claude-opus-4-20250514
```

---

## GitHub Apps & Credentials

### Storage

GitHub App credentials are stored in **Infisical** (the project's secret manager), never in git:

```
/dev/
  DEV_GITHUB_APP_ID
  DEV_GITHUB_APP_PRIVATE_KEY

/review/
  REVIEW_GITHUB_APP_ID
  REVIEW_GITHUB_APP_PRIVATE_KEY
```

### How They're Used

**In GitHub Actions Workflows:**
- Workflows fetch credentials from Infisical using an identity token
- Generate short-lived installation tokens from the App credentials
- Use those tokens for PR creation, commenting, commit attribution

**In Local Kilo Sessions:**
1. Authenticate to GitHub: `gh auth login` (uses existing token or prompts)
2. Set the session token: `export GH_TOKEN=$(gh auth token)`
3. All bash commands in Kilo use this token for GitHub operations

### Security

- Private keys never appear in logs, commits, or environment variables (except at workflow runtime)
- Short-lived tokens are used instead of static keys when possible
- Each App identity (dev/reviewer) is separate and independently revocable
- Code review on all commits catches accidental credential leaks

---

## agent-extensions

### Available Skills

Skills from `kgsmith19/agent-extensions` are loaded into Kilo and available by name:

```bash
@skill-creator                      # Create and test new skills
@canvas-design                      # Design visual art in .png/.pdf
@web-artifacts-builder              # Build React/Tailwind artifacts
```

Full list: run `/skills` in a Kilo session.

### Lazy Loading

Skills are **discovered at startup but not loaded until referenced**:
- Kilo scans `.kilo/vendor/agent-extensions/plugins/*/skills/` at startup
- Only when you invoke a skill (e.g., `@skill-creator`) is its content loaded
- No context bloat; no eager loading of unused skills

### MCPs (Model Context Protocol)

MCPs from agent-extensions and external marketplaces are defined in `kilo.json` with `enabled: false`:

```bash
/mcps                               # Toggle available MCPs
                                    # (space-bar to enable/disable)
```

### Bootstrap Scripts (Advanced)

For full agent-extensions integration (all external plugins from claude-plugins-official, superpowers-marketplace):

```bash
cd .kilo/vendor/agent-extensions
bash bootstrap/sync.sh              # Unix/macOS/Linux
pwsh bootstrap/sync.ps1             # Windows
```

This symlinks all external plugins and MCPs locally (optional; not required for daily use).

---

## Validation

To non-destructively verify the harness is configured correctly, run these 7 checks:

### 1. GitHub Apps Authenticate as Distinct Identities

```bash
# In a Kilo session as 'dev' agent:
gh api user --jq .login             # Shows dev app account name

# Switch to 'reviewer' context (or use a different GH_TOKEN):
GH_TOKEN=$REVIEW_TOKEN gh api user --jq .login   # Shows reviewer app account name
```

**Expected:** Two different GitHub App usernames.

### 2. AES is Discovered

```bash
cat AGENTS.md | head -20
cat standard.lock
python tools/standardctl.py verify --select policy
```

**Expected:** AGENTS.md present, standard.lock pinned to AES commit, policy check passes.

### 3. dev/reviewer Roles Use Correct Apps

```bash
cat .kilo/agent/dev.md | grep github_app
cat .kilo/agent/reviewer.md | grep github_app
/agents                             # Lists both 'dev' and 'reviewer'
```

**Expected:** Both agents reference their respective GitHub Apps.

### 4. Changing Model is Simple

```bash
/roles
/role set dev anthropic claude-opus-4-20250514
cat agent-roles.yaml | grep -A 2 "^dev:"
/role set dev anthropic claude-sonnet-4-20250514   # Revert
```

**Expected:** File edited, change visible immediately, one command sufficient.

### 5. GitHub Evidence Reports Exact Provider/Model

```bash
# Create a test PR (with [WIP] prefix so it doesn't merge):
git checkout -b test/kilo-validation
echo "test" > test.txt
git add test.txt
git commit -m "test: validation check"
git push -u origin test/kilo-validation
# Create PR via GitHub UI
```

Check PR's GitHub Actions logs → PR Verification job → Work State comment:
```
dev: anthropic/claude-sonnet-4-20250514
review: anthropic/claude-opus-4-20250514
```

**Expected:** Provider/model pair recorded in automated evidence.

### 6. agent-extensions Capabilities Discoverable

```bash
/skills                             # Lists skills from agent-extensions
/mcps                               # Lists available MCPs
@skill-creator                      # Try invoking a skill
```

**Expected:** Skills are listed and loadable; MCPs are discoverable.

### 7. No Credential Stored Insecurely

```bash
git status | grep -i secret
git log --all --grep="PRIVATE_KEY|API_KEY|TOKEN" --oneline
grep -r "PRIVATE_KEY|api_key|secret" .kilo/ --include="*.md" --include="*.json" --include="*.yaml"
echo $DEV_GITHUB_APP_PRIVATE_KEY | head -c 20   # Should be empty
```

**Expected:** No plaintext secrets in repo, config, or logs.

---

## Troubleshooting

### Q: Kilo is not picking up model changes from `/roles`

**A:** 
- Verify `agent-roles.yaml` was edited: `cat agent-roles.yaml`
- Check Kilo read it: run `/roles` again (may need to restart session)
- Verify the file has valid YAML (no typos)

### Q: GitHub Actions workflows still using repo vars instead of agent-roles.yaml

**A:**
- The workflows were modified to read `agent-roles.yaml` via a "Load agent roles" step
- If the step is missing, the workflows are not yet updated
- Check `.github/workflows/pr-verify.yml` for the step name "Load agent roles" near line ~160

### Q: GH_TOKEN is not set in local Kilo session

**A:**
```bash
# Ensure GitHub auth is configured:
gh auth status                      # Shows current auth status

# If not authenticated:
gh auth login                       # Interactive login with GitHub App credentials

# Set the token for this session:
export GH_TOKEN=$(gh auth token)

# Verify:
gh api user --jq .login
```

### Q: Dev and review agents have the same provider (should be different)

**A:**
- Edit `/agent-roles.yaml` and change one agent's provider
- Example: `dev: anthropic`, `review: openai`
- Run `/roles` to verify
- The next PR will validate and enforce this separation

### Q: agent-extensions skills are not discoverable

**A:**
- Verify submodule is initialized: `git submodule status`
- If submodule is not present: `git submodule init && git submodule update`
- Check skill paths in `kilo.json` point to correct plugin directories
- Run `/skills` again

### Q: Private key was accidentally logged/committed

**A:**
- **Immediately:** Revoke the GitHub App in GitHub Settings
- **Then:** Search git history for any traces: `git log -p | grep -i PRIVATE_KEY`
- **Report:** Notify the owner immediately if any key material was exposed
- **Regenerate:** Create a new GitHub App and update Infisical

---

## Files Reference

| File | Purpose | Created | Modified |
|------|---------|---------|----------|
| `/agent-roles.yaml` | Role config (dev/review model, provider, app names) | ✓ | ✓ |
| `/kilo.json` | Kilo runtime config (model, permissions, skills, MCPs) | ✓ | — |
| `.kilo/agent/dev.md` | Dev agent definition + system prompt | ✓ | — |
| `.kilo/agent/reviewer.md` | Reviewer agent definition + system prompt | ✓ | — |
| `.kilo/command/role-set.md` | `/role set` command documentation | ✓ | — |
| `.kilo/command/roles-show.md` | `/roles` command documentation | ✓ | — |
| `.kilo/command/roles-sync.md` | `/roles sync` command documentation | ✓ | — |
| `.kilo/vendor/agent-extensions/` | Agent-extensions submodule (skills, MCPs, plugins) | ✓ | — |
| `.kilo/HARNESS.md` | This file (integration guide) | ✓ | — |
| `.github/workflows/pr-verify.yml` | PR verification workflow | — | ✓ |
| `.github/workflows/dev-agent-dispatch.yml` | Dev agent dispatch | — | ✓ |
| `.github/workflows/dev-agent-post.yml` | Dev agent post-review | — | ✓ |

---

## Next Steps

1. **Commit all files:** Ensure all `.kilo/`, `agent-roles.yaml`, `kilo.json` are committed to `feat/kilo-harness-config` branch
2. **Create a PR:** Open PR against `main` with title `chore: add kilo harness configuration`
3. **Run validation:** Execute the 7 checks from the "Validation" section above
4. **Merge:** Once PR Gate passes and validation is clean, merge to main
5. **Start using:** Switch to Kilo harness for daily development

---

**Questions?** See `.kilo-harness-plan.md` for the full architectural specification.
