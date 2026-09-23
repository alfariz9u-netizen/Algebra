# Setup Instructions

Nothing in this project fakes a result. If a credential is missing, the
relevant connector reports `CREDENTIAL_REQUIRED` and any task that actually
needs it fails honestly (see `test/universal_agent_pipeline.test.js` /
`src/index.js` behavior with no keys set).

## 1. Base requirements

```bash
npm install
```

Node.js 18+ (built-in `fetch`).

## 2. LLM providers

### Gemini — real free tier

```bash
export GEMINI_API_KEY=your_key_here      # https://aistudio.google.com/apikey
```

Also powers the semantic memory cache (real embeddings via `embedContent`).

### Grok / xAI — no ongoing free tier

```bash
export XAI_API_KEY=your_key_here         # https://console.x.ai
```

### Provider selection

```bash
export LLM_PROVIDER=auto     # default: Gemini first, Grok fallback
export LLM_PROVIDER=gemini
export LLM_PROVIDER=grok
```

## 3. Autonomy level

```bash
export AUTONOMY_LEVEL=0   # MANUAL — everything needs approval (default)
export AUTONOMY_LEVEL=1   # ASSISTED — can research/prepare, not execute
export AUTONOMY_LEVEL=2   # LIMITED_AUTONOMY — low-risk actions run automatically
export AUTONOMY_LEVEL=3   # CONTROLLED_AUTONOMY — predefined workflows within budgets
```

HIGH-risk actions (payments, withdrawals, credential/system changes) always
require approval regardless of this setting — see `src/core/riskEngine.js`.

## 4. Connectors

### The Colony (free — register at https://thecolony.cc/connect-agent)

```bash
export COLONY_API_KEY=your_key_here
```

### Artifact Council

Read-only directory browsing works with no setup. Write operations
(propose/vote/apply) are intentionally disabled until the exact API is
confirmed from `https://artifactcouncil.com/skill.md` — see the comment
in `src/connectors/artifactCouncil.js`.

### OpenTask.ai

```bash
export OPENTASK_API_KEY=your_key_here    # see https://opentask.ai/docs
```

### AgenC (Solana)

```bash
npm install @tetsuo-ai/marketplace-sdk @solana/kit
solana-keygen new --outfile ~/agenc-worker.json
export AGENC_RPC_URL=https://api.mainnet-beta.solana.com
export AGENC_WALLET_PATH=~/agenc-worker.json
```

Fund the wallet with ~0.03–0.05 SOL before submitting deliverables; register
the agent on-chain first per https://agenc.ag/docs/quickstart-workers.

### AgentBazaar (Solana, Python SDK bridge)

```bash
python3 -m pip install agentsbazaar
export SOLANA_PRIVATE_KEY=your_base58_or_json_key   # or ~/.config/solana/id.json
```

### Azure / Microsoft Marketplace

```bash
export AZURE_TENANT_ID=your_tenant_id
export AZURE_CLIENT_ID=your_app_client_id
export AZURE_CLIENT_SECRET=your_app_client_secret
```

Requires a Partner Center account with a published SaaS offer.

### GitHub

```bash
export GITHUB_TOKEN=your_fine_grained_pat
```

### Molt Market

Free to register, no wallet required for discovery:

```bash
# One-time: register a free agent (via a short Node script or curl)
curl -X POST https://moltmarket.store/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "YourAgentName", "skills": ["research", "coding"]}'
# -> save the returned api_key
export MOLTMARKET_API_KEY=molt_xxx...
```

Note: as of the docs used to build this connector, the platform itself caps
real money movement at $0.05–$0.25 USDC per job and explicitly fails closed
(`503`/`402`) until its own independent safety gates (settlement, arbitration
quorum) pass — always call `checkHealth()` before assuming a financial
action will do anything. This connector surfaces those statuses as real
errors, never as a faked success.

### MCP

```bash
export MCP_SERVER_URL=https://your-mcp-server/endpoint
export MCP_ALLOWED_TOOLS=tool_one,tool_two   # explicit allow-list, deny by default
```

Once set, two things become true:

1. `agent.connectors.get("mcp")` is `CONNECTED` and callable manually
   (`await mcp.listTools()`, `await mcp.callTool(name, args)`), same as
   before.
2. **New**: the `webResearch` capability (the one capability whose whole
   job structurally requires current external information) will actually
   use it. `UniversalAgent._executeWithTools()` runs a small, hard-bounded
   tool-use loop (`MCP_MAX_TOOL_ITERATIONS`, default 3 round-trips) via
   real Gemini/xAI function-calling: the model can ask for one of the
   server's allow-listed tools, gets a real result back, and can ask again
   before giving its final answer. Every tool call still goes through
   `callConnector` (kill switch, rate limiter, audit) exactly like any
   other connector call, and a failure anywhere in the chain — the server
   unreachable, `tools/list` failing, the circuit breaker open from recent
   repeated failures (`learningEngine.js`) — degrades to the *exact* old
   single-call behavior rather than failing the task. No other capability
   is affected; this is opt-in per capability (`allowsTools: true` in
   `src/capabilities/definitions.js`), not a global change to how the
   agent calls the model. Proven in `test/mcp_tool_loop.test.js`.

If you want a different capability to be able to use MCP tools too, add
`allowsTools: true` to its definition — no other wiring needed, the same
`_executeWithTools` path picks it up automatically.

### A2A

No environment variable needed — the caller supplies a target agent's base
URL per call (`agent.connectors.get("a2a").fetchAgentCard(url)`).

#### A2A inbound — making this agent discoverable/hireable (`src/a2aServer.js`)

The above is the OUTBOUND client (this agent calling another agent). To
let OTHER agents discover and call THIS agent, run the separate inbound
server:

```bash
export A2A_SERVER_PORT=8787
export A2A_SERVER_PUBLIC_URL=https://your-service.onrender.com   # the URL others will reach it at
export A2A_SERVER_SHARED_SECRET="a long random token"            # optional but recommended
npm run a2a-server
```

Serves `GET /.well-known/agent-card.json` (public discovery — always
unauthenticated, per spec norms: an agent that can't be found can't be
hired) and `POST /a2a` (JSON-RPC 2.0, `message/send` only — no
`tasks/get` polling or streaming yet). Every inbound message runs through
the *exact same* `UniversalAgent.processTask()` pipeline as every other
task source: risk/autonomy gate (a request that maps to a MEDIUM/HIGH-risk
capability lands in the human approval queue, it does not auto-execute
just because a remote agent asked), budget preflight, verification, QA —
and the caller's text is always treated as `untrustedContent`, never as
instructions to the framework itself. A dedicated per-IP rate limiter
(separate from the outbound connector limiter, so a noisy public endpoint
can't starve the agent's own marketplace bidding) and a request-size cap
protect against abuse. Proven in `test/a2a_server.test.js`.

The A2A `message/send` spec carries no payment mechanism — `rewardUsd`
recorded for an inbound request is whatever the caller *self-reports* in
`message.metadata.rewardUsd`, unverified. Treat this channel as reputation-
/service-building unless payment is separately arranged (escrow, invoice,
a platform wrapping A2A) — see the HONESTY NOTEs at the top of
`src/a2aServer.js`.

On Render specifically: the service's local disk is ephemeral by
default — `PERSIST_DIR` state (including `LearningEngine`'s circuit
breaker/dead-listing memory) survives within one running process but is
wiped on every redeploy/restart unless you attach a persistent disk and
point `PERSIST_DIR` at it. The rate limiter and shared-secret check above
work regardless of persistence config.

## 5. Persistence (optional)

```bash
export PERSIST_DIR=./data   # omit for in-memory-only, the default
```

Real, working, zero-dependency file-backed persistence
(`src/core/persistence/fileStore.js`) — a snapshot file for the memory
cache, append-only JSONL logs for the audit trail and economic events.
Survives a real process restart (proven in
`test/persistence_restart.test.js`); not a database, so it won't scale to
concurrent multi-process access — see `src/db/schema.sql` for the schema a
production Postgres migration should use instead.

### Encryption at rest

```bash
export PERSIST_ENCRYPTION_KEY="a strong passphrase"
```

Strongly recommended whenever `PERSIST_DIR` is set. Encrypts every
persisted file with real AES-256-GCM — see `test/encrypted_agent_restart.test.js`
for proof the raw files on disk contain no recoverable plaintext.
Using the wrong passphrase on a later run throws loudly rather than
silently starting fresh.

### Retention / cleanup

```bash
export AUDIT_MAX_AGE_MS=$((30*24*60*60*1000))
export ECONOMICS_MAX_ENTRIES=100000
export MEMORY_MAX_RECORDS=50000
node src/maintenanceCli.js
```

Run this periodically (e.g. a daily cron) to actually shrink the persisted
files — without it, they grow forever. Financial totals in `economics.summary()`
are preserved via a rollup counter even after old events are pruned.

## 6. Human approval interface

```bash
export PERSIST_DIR=./data   # required — approvals are created and resolved in different processes
node src/approvalCli.js list
node src/approvalCli.js approve <approvalId> yourName
node src/approvalCli.js resume <approvalId>
```

Any task/action that needs human sign-off (MEDIUM-risk at low autonomy
levels, or any HIGH-risk action regardless of autonomy level) now gets a
real, listable, resolvable `approvalId` instead of a dead-end status.
`resume` re-runs the exact original task, still subject to every other
gate (budget, verification, QA) — approval only skips the approval check
itself.

### Telegram (mobile-friendly alternative to the CLI)

For reviewing from a phone instead of a terminal. This is a second
interface onto the exact same approval queue above — not a replacement
for it, and the CLI still works with no network dependency if Telegram
is ever unreachable.

```bash
# 1. Create a bot via @BotFather in Telegram, copy its token.
# 2. Message your new bot once, then find your numeric chat id:
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"

export TELEGRAM_BOT_TOKEN="<token from BotFather>"
export TELEGRAM_ALLOWED_CHAT_IDS="<your chat id>[,<another reviewer's id>]"
export PERSIST_DIR=./data   # required — same dir the agent process uses

npm run telegram-bot
```

Refuses to start with no `TELEGRAM_ALLOWED_CHAT_IDS` set — a reviewer bot
with no allowlist would let anyone who messages it approve high-risk
actions. Anyone not on the allowlist gets a flat "Not authorized." for
every command and every button press. Long-polling only (`getUpdates`),
so no public domain/HTTPS endpoint is required.

You'll get a message with Approve/Deny buttons whenever a new approval is
needed (task-input previews are redacted the same way the audit log is,
before being sent to Telegram). `/status` gives a dashboard summary,
`/pending` re-lists anything still waiting. It does not yet expose the
kill switch — use the CLI or `killSwitch` API directly for an emergency
stop.

## 7. Run it

```bash
npm start
```

Prints every connector's real status, runs one demo task through the full
pipeline, and prints the dashboard.

## 8. Run the tests

```bash
npm test
```

No network or API keys required — tests use a local fixture server shaped
like the real Gemini/xAI APIs to verify request/response handling, plus pure
unit tests for the deterministic subsystems (budgeting, permissions, kill
switch, prompt-injection guard, connector honesty, audit redaction).

## 9. Running everything on one free Render service

`npm run a2a-server`, `npm run telegram-bot`, and the marketplace pipeline
each ran as separate processes/scripts up to this point. Render's free
tier gives ~750 instance-hours/month per workspace — enough for ONE
always-on service, not several — so running all three together requires
combining them into one process:

```bash
npm run start:combined   # src/combinedServer.js
```

This runs, in one process sharing one agent: the A2A server (the only
listening port — this is what Render treats as "the service" and what
should receive external health pings), the Telegram approval bot (if
`TELEGRAM_BOT_TOKEN` is set), and a scheduler that runs one
`MarketplacePipeline` cycle per strategy every `MARKETPLACE_CYCLE_MS`
(default 30 minutes — matching the cadence already observed in
production). A failure in any one of the three is caught and logged, not
allowed to crash the others.

To keep Render from spinning this down after 15 minutes of no incoming
traffic (which would silently kill the Telegram poll loop and the
scheduler along with the HTTP server — Render's idle timer only resets on
inbound requests, not on background CPU activity), point a free external
uptime monitor (UptimeRobot, cron-job.org, etc.) at:

```
GET https://<your-service>.onrender.com/healthz
```

on a schedule under 15 minutes (10-14 min is typical). Running one
service this way uses close to the full 750 free hours for the month —
there usually isn't headroom left for a second always-on free Render
service on the same workspace.

Set `PERSIST_DIR` for this combined process — the Telegram bot's approval
notifications are read from the same persisted approval-queue file the
agent writes to, even though they're in the same process now (see
`src/combinedServer.js` for why). Render's disk is otherwise ephemeral
across redeploys (see the MCP/A2A sections above), which doesn't affect
this — it only needs to survive the one running process.

**Watching LLM free-tier consumption**: the default marketplace cadence
(3 strategies × 1 opportunity every 30 min, plus QA grading) is roughly
150-200 model calls/day on its own — comfortably inside most providers'
free daily quota. What can push it higher: an A2A inbound endpoint left
open to the whole internet (keep `A2A_SERVER_SHARED_SECRET` set), and the
MCP tool-use loop if enabled (keep `MCP_MAX_TOOL_ITERATIONS` low, e.g. 1-2,
until you've watched real usage). Gemini in particular retires models on
a strict ~12-month cycle and fully shuts the old endpoint off (no
auto-redirect) — if calls start failing outright, check
https://ai.google.dev/gemini-api/docs/deprecations and set `GEMINI_MODEL`
to the current replacement.
