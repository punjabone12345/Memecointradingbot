---
name: Artifact-managed workflow port conflicts
description: Platform auto-generates "artifacts/*" workflows that duplicate custom .replit workflows and race for the same ports
---

This project (an Agent-created multi-artifact app: terminal=web, api-server=api, mockup-sandbox=design)
has TWO parallel run mechanisms active at once:

1. Custom workflows defined in `.replit` (e.g. `Apex Meme Trader`, `API Server`), which run the exact
   same `pnpm --filter ... run dev` commands.
2. Platform-managed workflows automatically named `artifacts/<dir>: <label>` (e.g.
   `artifacts/api-server: API Server`, `artifacts/terminal: web`) that the platform spins up on its
   own for each detected artifact directory, seemingly independent of `.replit`.

Both mechanisms can end up bound to the same ports (e.g. 8080 for the API), causing `EADDRINUSE` and
"Project workflow had failing tasks" errors on every restart, even though the underlying app code is
fine.

**Key facts:**
- `removeWorkflow()` on an `artifacts/*` workflow fails with `PROHIBITED_ACTION: is managed by an
  artifact and cannot be deleted via deleteRunWorkflow`. These cannot be removed.
- The custom `.replit`-defined workflows CAN be removed via `removeWorkflow()`.
- The `artifacts/api-server: API Server` workflow hardcodes the same port as the app's own code
  (e.g. 8080), so it collides directly with a custom workflow targeting that port.
- The `artifacts/terminal: web` (vite) workflow does NOT default to port 5000 — it ran on a
  different port (e.g. 25245) tracked in `.replit`'s `[[ports]]` section, which breaks the Replit
  webview convention (webview requires port 5000).

**Fix that worked:** remove the redundant custom `.replit` workflows that duplicate an
artifact-managed one (e.g. custom "API Server"), and let the artifact-managed workflow serve that
role. For the primary web view (which must be on port 5000), recreate a custom workflow that
explicitly sets `PORT=5000` in its command (e.g.
`PORT=5000 pnpm --filter @workspace/terminal run dev`) so it doesn't collide with the
artifact-managed terminal workflow running on its own separate port.

**Why:** you cannot delete the artifact-managed workflow, so any port conflict must be resolved
from the custom-workflow side — either remove the custom workflow (if the artifact-managed one
already serves that role adequately) or force it onto a distinct/required port.

**How to apply:** if a workflow restart fails with `EADDRINUSE` or "had failing tasks" in a
multi-artifact project, run `listWorkflows()` first to check for duplicate `artifacts/*` entries
before assuming the app code is broken.
