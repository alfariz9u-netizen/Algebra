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

### A2A

No environment variable needed — the caller supplies a target agent's base
URL per call (`agent.connectors.get("a2a").fetchAgentCard(url)`).

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
