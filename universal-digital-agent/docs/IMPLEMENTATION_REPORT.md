# Implementation Report — Universal Digital Agent

## 1. What was changed

- Removed the 9-independent-agent architecture (`src/agents/*`, `src/agentManager.js`) entirely.
- Replaced it with `src/core/universalAgent.js`: one orchestrator that classifies intent, selects exactly one capability, and runs it through permission/risk/budget/cache gates before ever calling an LLM.
- Introduced the full control-plane module set under `src/core/`: `tokenController`, `modelRouter`, `memoryCache`, `permissionSystem`, `riskEngine`, `auditLog`, `killSwitch`, `autonomyLevels`, `promptInjectionGuard`, `verificationLayer`, `connectorRegistry`, `opportunityEngine`, `economicIntelligence`, `intentClassifier`.
- Converted the previous 9 agent classes into 18 declarative capability configs (`src/capabilities/definitions.js`) — configuration + prompt-building, not autonomous objects that call each other.
- Moved marketplace adapters into `src/connectors/` and added new real connectors: The Colony, Artifact Council, OpenTask.ai, GitHub, Molt Market (moltmarket.store — verified via their public docs; deliberately NOT connected to the unrelated "Molt Road" black-market platform flagged by security researchers), a minimal real MCP JSON-RPC client, a minimal real A2A protocol client.

## 2. What was reused

- `src/llm/geminiClient.js`, `src/llm/grokClient.js` — extended (added embeddings to Gemini, usage-token reporting) but not rebuilt.
- `src/connectors/agenc.js`, `agentBazaar.js`, `azureMarketplace.js` — the real adapters built earlier, moved as-is and given a `status()` method for the registry.
- `src/localization/` (i18n templates, `en-US.json`) — kept as available infrastructure for English-first templated messages; not yet wired into every core module's output (see TODOs).
- The English-first policy and free-tier/paid-tier honesty about Gemini vs. Grok from the previous iteration.

## 3. What is actually connected right now

Nothing requires no credentials except:
- **Artifact Council** — read-only directory browsing (`browseDirectory`, `getArtifact`) works with zero setup.
- **MCP** and **A2A** clients work against *any* real server/agent you point them at — they just have no default target configured.

Everything else — The Colony, OpenTask.ai, AgenC, AgentBazaar, Azure Marketplace, GitHub — is a real, working integration that reports `CREDENTIAL_REQUIRED` until you supply the credentials listed in `docs/setup.md`. This was verified by running `node src/index.js` with no environment variables set: every connector's `status()` returned an honest, non-`CONNECTED` value (see conversation transcript).

## 4. What requires credentials

| Connector | Credential | Cost to actually use |
|---|---|---|
| Gemini | `GEMINI_API_KEY` | Free tier |
| Grok/xAI | `XAI_API_KEY` | Paid after trial credit |
| The Colony | `COLONY_API_KEY` | Free |
| OpenTask.ai | `OPENTASK_API_KEY` | Depends on task fees |
| AgenC | Funded Solana keypair + `AGENC_RPC_URL`/`AGENC_WALLET_PATH` | Real SOL (tx fees + rent) |
| AgentBazaar | Solana keypair, `python3` + `pip install agentsbazaar` | Real SOL |
| Azure Marketplace | Partner Center account, `AZURE_TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET` | Depends on offer |
| GitHub | `GITHUB_TOKEN` | Free |
| Molt Market | `MOLTMARKET_API_KEY` | Free registration; job budgets capped at $0.05–$0.25 by the platform's own canary, settlement fails closed until platform-side gates pass |
| MCP | `MCP_SERVER_URL`, `MCP_ALLOWED_TOOLS` | Depends on server |

## 5. What is unsupported (marked, not faked)

- **Artifact Council write operations** (propose/vote/apply): I could not confirm the exact REST endpoint shapes for these at build time. `proposeArtifact()` throws a clear `NOT_SUPPORTED` error rather than guessing a payload that might not match the real API. Fix: fetch `https://artifactcouncil.com/skill.md` and fill in the real endpoint.
- **OpenTask.ai exact endpoint paths**: built from their documented high-level API surface using a conventional REST shape; not verified request-by-request against a live account. Treat any 404 as a signal to adjust the path.
- **MoltMarket, agent-to-agent self-modification of production code**: not implemented — the spec explicitly prohibits uncontrolled self-rewriting (section 25/32), so no such mechanism exists. "Self-improvement" here means: the memory/cache accumulates verified results over time, and Colony/Artifact Council give the agent a channel to read what other agents have learned — not code self-modification.

## 6. Token-saving mechanisms

- Deterministic keyword-based intent classification before any LLM call (`intentClassifier.js`) — an LLM is only invoked for genuinely ambiguous input.
- Exact-match cache checked before every LLM call.
- Real semantic cache (Gemini embeddings + cosine similarity, threshold configurable via `SEMANTIC_CACHE_THRESHOLD`) checked before every LLM call.
- Per-task, per-operation, and daily token budgets enforced *before* spending anything (`tokenController.js`), tested in `test/token_controller.test.js`.
- Model tiering (`fast`/`default`/`strong`) so simple tasks (classification, QA grading, task management) use cheaper/faster models than coding or debugging.
- Deterministic verification preferred over a second LLM call "agreeing" with the first (code syntax via `node --check`, JSON schema checks, recomputed arithmetic).

## 7. Security mechanisms

- Deny-by-default permission system with agent+task+resource+action scoping and automatic expiry (`permissionSystem.js`, tested).
- Deterministic risk classification; HIGH-risk actions always require human approval regardless of autonomy level (`riskEngine.js`).
- Global and per-connector kill switch (`killSwitch.js`, tested).
- **Encryption at rest** — **DONE**: real AES-256-GCM via Node's built-in `crypto` (`src/core/persistence/encryption.js`), opt-in via `PERSIST_ENCRYPTION_KEY`, fresh IV per write, authenticated (tamper-evident), wrong-key attempts throw rather than silently starting empty. Proven in `test/encryption.test.js` and `test/encrypted_agent_restart.test.js` (confirms zero recoverable plaintext in the raw on-disk files after a full agent run).
- **Database cleanup / retention** — **DONE**: `MemoryCache.pruneExpired()`, `AuditLog.prune()`, `EconomicIntelligence.prune()`, and a top-level `UniversalAgent.runMaintenance()` / `src/maintenanceCli.js` physically remove old/excess records and compact the on-disk files — they used to only be skipped at read time, growing forever. Economic pruning specifically preserves lifetime revenue/cost via a persisted rollup counter rather than silently losing financial history. Proven in `test/retention_pruning.test.js`, plus a live 3-separate-process demonstration during development.
- **SSRF protection** (`ssrfGuard.js`, tested against 9 cases including decimal/hex IP obfuscation and a simulated DNS-rebinding attack) — wired into the A2A client so a malicious remote agent's card can't be used as a confused deputy to reach internal infrastructure or cloud metadata endpoints.
- **Prompt-injection guard hardened against real bypass techniques**: zero-width/invisible Unicode character stripping, HTML-comment instruction smuggling, base64-decode-then-obey smuggling, and mandatory content-length capping to prevent context-flooding — all with adversarial tests, and confirmed not to false-positive on ordinary accented text.
- **Secret redaction by value shape, not just field name** — catches OpenAI/Anthropic/GitHub/Slack/Google-shaped keys and PEM blocks even if they leak under an unrelated field name.
- **Token-bucket rate limiting per connector**, enforced through a single mandatory gate (`UniversalAgent.callConnector()`) that also refuses any operation a connector hasn't explicitly declared support for, and checks the kill switch first — tested end to end, including proof that an unsupported operation is refused *without ever running the underlying function*.
- **MCP client hardening**: deny-by-default tool allow-list (refuses tools even if the server advertises them), request timeout, and size caps on both outgoing tool arguments and incoming responses — tested against a fixture server that simulates a hung connection and an oversized response.
- Audit log that redacts secret-shaped fields but not legitimate metrics like token counts (`auditLog.js`, tested — this exact over-redaction bug was caught and fixed during development).
- A2A client refuses to message an agent whose card is missing required fields, and treats all remote agent output as untrusted.
- **Correctness bug caught while building the pipeline integration test**: `intentClassifier.js` used naive substring matching for single-word keywords, so the trigger word "script" (intended for coding tasks) silently matched inside the ordinary word "description" and misrouted an unrelated task into the wrong capability. Fixed to use word-boundary regex matching for single-word keywords (multi-word phrases still use substring matching, since they don't have this collision risk). A second fix — letting a task's own `type` field exact-match a capability name before any keyword scanning — also made strategy-generated tasks (from `marketplacePipeline.js`) route correctly and more cheaply (zero string scanning needed).
- **Second correctness bug caught while building the persistence-restart test**: the word-boundary fix above used JavaScript's `\b`, which treats underscore as a word character — so the keyword "research" then failed to match inside the everyday task-type string "research_report" (no boundary between "h" and "_"). Fixed by replacing `\b` with an explicit alnum-only boundary (lookaround against `[A-Za-z0-9]`), which correctly treats underscores/punctuation as separators while still rejecting "script" inside "description". Both fixes are covered by regression tests running together (`test/persistence_restart.test.js` exercises the exact "research_report" case; `test/adversarial_prompt_injection.test.js` and the classifier's own behavior exercise the "description" case).

## 8. Remaining TODOs

- Wire `src/localization/i18n.js` templates into every core module's user-facing strings (currently only used historically; core modules use plain English strings directly).
- Confirm and implement Artifact Council's write API.
- Add a persistent store (Postgres, using `src/db/schema.sql`) for a real production deployment — the current file-backed store (`src/core/persistence/fileStore.js`) is real, working, zero-dependency persistence (proven in `test/persistence_restart.test.js`), but a single-node JSON/JSONL file store won't scale to concurrent multi-process access the way Postgres would.
- Add real embeddings-based semantic cache persistence across restarts.
- Build the human-approval UI/CLI for `pending_human_approval` results — **DONE**: `src/core/approvalQueue.js` + `src/approvalCli.js`, proven with real separate OS processes and covered by `test/human_approval_workflow.test.js` and `test/approval_queue.test.js`.
- Load-test the token controller's daily budget rollover across real multi-day runs.
- Add adversarial prompt-injection test cases beyond the current pattern set (spec section 33 asks for broader adversarial security tests).
- `UniversalAgent.callConnector()` is the single sanctioned gate for connector calls (kill switch + support check + rate limit + audit). It is now actually used automatically: `src/core/marketplacePipeline.js` bridges capability execution to connector actions for **Molt Market** (discover → bid, and separately: check notifications → deliver accepted work), **OpenTask.ai** (discover → bid), and **AgenC** (discover → deliver → submit) — proven end-to-end in `test/marketplace_pipeline.test.js` and `test/molt_market_delivery.test.js`. AgentBazaar is NOT wired into this earning loop — its connector is built for the opposite direction (hiring/paying other agents), not getting hired, so it doesn't fit this pattern; delegating a subtask to a hired AgentBazaar specialist would need a different, not-yet-built flow.
- Extend `ssrfGuard` re-validation to long-lived connections (current DNS-rebinding defense re-checks at request time; a connector that holds a URL and calls it repeatedly over a long session should re-validate periodically, not just once).
- Add rate-limit tuning per connector (current limiter uses one global capacity/refill config for all connectors; a production deployment should set tighter limits for higher-risk connectors like payment-capable ones).
- AgenC opportunity pricing — **DONE**: `src/core/priceOracle.js` fetches a real live SOL/USD price from CoinGecko's public API (cached, with `AGENC_SOL_USD_PRICE` as a manual override and honest stale-cache/failure handling — never fabricates a price). Proven in `test/price_oracle.test.js` with an injectable fetcher so the test suite doesn't depend on live network access.
- OpenTask strategy's field names (`reward_usd`, `title`, `description`) are a reasonable guess from their documented API surface, not verified field-by-field against a live account — adjust `src/core/strategies/openTask.js` if real responses use different field names.
- `deliverAcceptedMoltMarketJobs()`'s notification-type filter (`bid_accepted`/`job_assigned`/`bid.accepted`) is a best guess at the real event names Molt Market sends — confirm against a live account and adjust if needed.
- Encryption-at-rest protects file *contents* but not metadata: file names, directory structure, and file sizes are still visible to anyone with filesystem access (e.g. the mere existence of `approvals.json` reveals there's an approval queue). The passphrase itself also lives in process memory and the environment while running — this defends against someone finding an old backup/disk image, not against compromising the live process.
- Retention pruning is manual/scheduled (via `maintenanceCli.js`), not automatic — nothing currently prunes on a timer inside the running agent process itself; you need an external cron or similar.

## 9. How the single agent operates

`UniversalAgent.processTask(task)`:
1. Kill-switch check.
2. Classify intent (deterministic first, LLM fallback only if needed).
3. Look up the one matching capability; grant + check its required permission; check risk/autonomy gating (may return `pending_human_approval` here).
4. Build the prompt; label any untrusted external content.
5. Check exact + semantic cache — return immediately on a hit, no LLM call.
6. Token/budget preflight — refuse before spending anything if over budget.
7. One real LLM call via the tiered model router.
8. Deterministic verification, then one QA grading call.
9. Store the verified result to memory/cache; record economics; return the deliverable with full audit trail attached.

## 10. Adding future connectors without changing the core

Implement the same shape as any file in `src/connectors/`: a class with a
`status()` method returning one of the registry's defined statuses, and
whatever real operations it actually supports. Register it in `src/index.js`
via `agent.connectors.register(name, { instance, capabilities, statusFn })`.
No change to `UniversalAgent`, `permissionSystem`, `riskEngine`, or any other
core module is required — they only ever interact with connectors through
the registry's `status()`/`supports()` interface.
