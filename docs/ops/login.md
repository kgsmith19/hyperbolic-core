# Signing in to Hyperbolic Core

**URL:** https://core.kylegsmith.com, from any browser, phone or network.

1. Open the URL. Cloudflare Access asks for your email.
2. Enter your owner email (the one in the "Owner Only" Access policy). Cloudflare emails you a
   6-digit code.
3. Enter the code. You land in the Hyperbolic Core Shell, already signed in: the platform trusts
   the identity Cloudflare just verified (single sign-on, #562). There is no second password step.

The login lasts 24 hours (Access session), and the Shell keeps its own session fresh in the
meantime. **Sign out** in Settings ends the app session; signing in again goes through
Cloudflare. Every app lives under the same login:

| Area | Path |
| --- | --- |
| Shell (home, tools, prompts, ideas, settings) | `/` |
| LifeOS | `/life/` |
| Brain API (used by the Shell) | `/api/brain/` |

## If something goes wrong

- **Cloudflare says you are not authorized**: you used an email that is not in the Owner Only
  policy. Use the owner email. Only the owner can change the policy (`docs/ops/cloudflare-agent-access.md`).
- **No code arrives**: check spam. Codes only go to the approved email; any other address gets no code.
- **The Shell shows a password form**: single sign-on could not complete (for example, the Access
  session expired mid-visit). Reload the page to go through Cloudflare again. As a break-glass
  option, the platform password is in Infisical at `prod:/platform/core/PLATFORM_OWNER_PASSWORD`,
  together with the same owner email.
- **The site does not load at all**: see `docs/ops/cloud-deploy.md`. `infra/cloudflare/cf.sh verify`
  checks the tunnel, and `ops/cloud/remote.sh smoke` checks the apps.

Locally (`make up` plus `npm run dev --workspace=shell`) there is no Cloudflare in front, so the
Shell shows its password form. Use the password `make init` printed.
