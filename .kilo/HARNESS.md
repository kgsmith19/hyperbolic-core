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
   /status              # Displays current agent and model config
   ```

4. **Begin work per AES:**
   - Create or claim a thin Issue
   - Create a worktree: `git worktree add .worktrees/issue-N-slug -b issue/N-slug`
   - Implement, test (TDD), commit, PR
   - Respond to AI Review findings
   - Merge when PR Gate passes

---

## Architecture

### Core Components

**1. `/kilo.json` — Kilo Runtime Config**

- Model and provider selection for dev and reviewer agents
- Permission rules for dev/reviewer agents
- Skill paths (agent-extensions plugins)
- MCP definitions (disabled by default, enable on demand)
- **External:** Store in local `.env` or Kilo config (`~/.config/kilo/`); never commit to repo

**2. `.kilo/agent/` and `.kilo/command/` — Agent & Command Definitions**

- `dev.md`: Implementation agent system prompt + frontmatter
- `reviewer.md`: Independent reviewer system prompt + frontmatter
- `command/role-set.md`, `command/roles-show.md`, `command/roles-sync.md`: Role management CLI commands

**3. `.kilo/vendor/agent-extensions/` — Skills & MCPs**

- Skills from agent-extensions (anthropic-product-skills, general-skills)
- MCPs from external marketplaces
- Lazy-loaded when referenced

---

## Roles

### dev (Primary Implementation Agent)

| Property | Value |
|----------|-------|
| Mode | `primary` |
| Model | `anthropic/claude-haiku-4-5` (configurable in `kilo.json`) |
| GitHub App | `hyperbolic-core-dev` |
| Responsibilities | Write code, create PRs, respond to reviews, merge when ready |
| Permissions | Broad: bash, edit (apps/packages/services/.github/config), read, glob, grep, task |

**When to use:** Every development task (feature, bugfix, refactor, documentation)

### reviewer (Independent LLM Review)

| Property | Value |
|----------|-------|
| Mode | `subagent` |
| Model | `openai/gpt-4o` (configurable in `kilo.json`) |
| GitHub App | `hyperbolic-core-reviewer` |
| Responsibilities | Evaluate PRs, report findings, block/allow merge |
| Permissions | Read-only + task (no direct edits, only comments/findings) |
| Invariant | Provider family MUST differ from `dev` |

**When to use:** PR review gate (triggered by AI Review workflow; usually not manual)

---

## Changing Models

Provider and model selection is **external to the repository** for low friction and easy changes. Configure in local Kilo config or environment variables.

### Option 1: Edit Local Kilo Config

Edit `~/.config/kilo/kilo.json` (your global Kilo config):
```jsonc
{
  "model": "anthropic/claude-haiku-4-5",           // Dev agent model
  // ... other config
}
```

Or create a project-local override in `hyperbolic-core/.env.kilo`:
```bash
KILO_MODEL=anthropic/claude-opus-4-20250514
KILO_SMALL_MODEL=anthropic/claude-haiku-4-5
```

### Option 2: Use Kilo `/models` Command

```bash
/models                 # Interactive model picker for current agent
```

This changes the model for the current session only.

### Option 3: Environment Variable

```bash
export KILO_MODEL=anthropic/claude-opus-4-20250514
kilo
```

### Verifying Current Config

```bash
/status                 # Shows current model and agent config
```

**Why external:** Provider/model selection is a developer preference, not a repository concern. Keeping it outside the repo means:
- Easy to change at any time without commits
- No merge conflicts from model changes
- Low friction for experiments
- Clean git history (no churn from provider changes)

---

## GitHub Apps & Credentials

### Storage

GitHub App credentials are stored in **Infisical** (the project's secret manager), **never in git or in local Kilo config**:

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
- Kilo config files (local or global) never contain credentials

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

To non-destructively verify the harness is configured correctly, run these checks:

### 1. AES is Discovered

```bash
cat AGENTS.md | head -20
cat standard.lock
python tools/standardctl.py verify --select policy
```

**Expected:** AGENTS.md present, standard.lock pinned to AES commit, policy check passes.

### 2. Kilo Agents Load

```bash
/agents                             # Lists both 'dev' and 'reviewer'
kilo --agent dev                    # Switch to dev agent
kilo --agent reviewer               # Switch to reviewer agent
```

**Expected:** Both agents are discoverable and switchable.

### 3. Kilo Models are Configurable

```bash
/status                             # Shows current model config
/models                             # Interactive model picker
```

**Expected:** Current model displayed; can change interactively.

### 4. agent-extensions Capabilities Discoverable

```bash
/skills                             # Lists skills from agent-extensions
/mcps                               # Lists available MCPs
@skill-creator                      # Try invoking a skill
```

**Expected:** Skills are listed and loadable; MCPs are discoverable.

### 5. No Credentials in Repository

```bash
git status | grep -i secret
git log --all --grep="PRIVATE_KEY|API_KEY|TOKEN" --oneline
grep -r "PRIVATE_KEY|api_key|secret" .kilo/ --include="*.md" --include="*.json"
grep -r "provider\|model" . --include="*.yml" --include="*.yaml"  # Should only find AES/project.yaml, not agent config
```

**Expected:** No plaintext secrets in repo; no provider/model config in YAML workflows.

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

| File | Purpose | In Repo | Notes |
|------|---------|---------|-------|
| `/kilo.json` | Kilo runtime config (model, permissions, skills, MCPs) | ✓ | Can be overridden locally; default has haiku-4-5 (dev), gpt-4o (review) |
| `.kilo/agent/dev.md` | Dev agent definition + system prompt | ✓ | References model from kilo.json or local config |
| `.kilo/agent/reviewer.md` | Reviewer agent definition + system prompt | ✓ | References model from kilo.json or local config |
| `.kilo/command/role-set.md` | `/role set` command documentation | ✓ | Documents how to change models externally |
| `.kilo/command/roles-show.md` | `/roles` command documentation | ✓ | Shows current agent config |
| `.kilo/command/roles-sync.md` | `/roles sync` command documentation | ✓ | Optional; for manual GitHub Actions bridging |
| `.kilo/vendor/agent-extensions/` | Agent-extensions submodule (skills, MCPs, plugins) | ✓ | Lazy-loaded; no eager context bloat |
| `.kilo/HARNESS.md` | This file (integration guide) | ✓ | — |
| `.github/workflows/*.yml` | GitHub Actions workflows | ✓ | No provider/model config; reads from repo vars only (legacy compat) |
| Local Kilo config | Provider/model selection | ✗ | `~/.config/kilo/kilo.json` or local `.env.kilo` |
| Infisical `/dev/`, `/review/` | GitHub App credentials | ✗ | Injected at workflow runtime; never in repo |

---

## Next Steps

1. **Commit all files:** Ensure all `.kilo/`, `agent-roles.yaml`, `kilo.json` are committed to `feat/kilo-harness-config` branch
2. **Create a PR:** Open PR against `main` with title `chore: add kilo harness configuration`
3. **Run validation:** Execute the 7 checks from the "Validation" section above
4. **Merge:** Once PR Gate passes and validation is clean, merge to main
5. **Start using:** Switch to Kilo harness for daily development

---

**Questions?** See `.kilo-harness-plan.md` for the full architectural specification.
