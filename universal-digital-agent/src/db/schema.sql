-- Reference relational schema (spec section 28). The current reference
-- implementation keeps all of this in-memory (see src/core/*.js); this
-- schema is what a production deployment should migrate that state into.
-- Swapping storage does not require changing the public interfaces of
-- MemoryCache, PermissionSystem, AuditLog, or EconomicIntelligence.

CREATE TABLE agents (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    autonomy_level  INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE capabilities (
    name            TEXT PRIMARY KEY,
    description     TEXT,
    default_tier    TEXT NOT NULL,
    default_risk    TEXT NOT NULL
);

CREATE TABLE connectors (
    name            TEXT PRIMARY KEY,
    kind            TEXT NOT NULL, -- e.g. 'marketplace', 'social', 'mcp', 'a2a', 'vcs'
    base_url        TEXT
);

CREATE TABLE connector_capabilities (
    connector_name  TEXT REFERENCES connectors(name),
    operation       TEXT NOT NULL,
    PRIMARY KEY (connector_name, operation)
);

CREATE TABLE permissions (
    action          TEXT PRIMARY KEY,
    risk_level      TEXT NOT NULL
);

CREATE TABLE permission_grants (
    id              SERIAL PRIMARY KEY,
    agent_id        TEXT REFERENCES agents(id),
    task_id         TEXT,
    resource        TEXT NOT NULL,
    action          TEXT REFERENCES permissions(action),
    status          TEXT NOT NULL, -- APPROVED, REVOKED, EXPIRED
    granted_at      TIMESTAMP NOT NULL DEFAULT now(),
    expires_at      TIMESTAMP
);

CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT REFERENCES agents(id),
    type            TEXT NOT NULL,
    capability      TEXT REFERENCES capabilities(name),
    source_connector TEXT REFERENCES connectors(name),
    status          TEXT NOT NULL, -- success, failed, pending_human_approval
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    completed_at    TIMESTAMP
);

CREATE TABLE opportunities (
    id                      TEXT PRIMARY KEY,
    source_connector        TEXT REFERENCES connectors(name),
    reward_usd              NUMERIC,
    estimated_effort_minutes INTEGER,
    estimated_model_cost_usd NUMERIC,
    platform_fee_usd        NUMERIC,
    success_probability     NUMERIC,
    risk_level              TEXT,
    expected_value_usd      NUMERIC,
    decision                TEXT -- accepted, rejected
);

CREATE TABLE executions (
    id              SERIAL PRIMARY KEY,
    task_id         TEXT REFERENCES tasks(id),
    capability      TEXT REFERENCES capabilities(name),
    started_at      TIMESTAMP NOT NULL DEFAULT now(),
    finished_at     TIMESTAMP,
    verification_passed BOOLEAN,
    qa_score        INTEGER
);

CREATE TABLE tool_calls (
    id              SERIAL PRIMARY KEY,
    task_id         TEXT REFERENCES tasks(id),
    connector_name  TEXT REFERENCES connectors(name),
    operation       TEXT NOT NULL,
    result_status   TEXT NOT NULL,
    called_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE model_calls (
    id              SERIAL PRIMARY KEY,
    task_id         TEXT REFERENCES tasks(id),
    provider        TEXT NOT NULL, -- GeminiClient, GrokClient
    model           TEXT NOT NULL,
    tier            TEXT NOT NULL, -- fast, default, strong
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    total_tokens    INTEGER,
    cost_usd        NUMERIC DEFAULT 0,
    called_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE token_usage (
    task_id         TEXT REFERENCES tasks(id),
    day             DATE NOT NULL,
    tokens_used     INTEGER NOT NULL,
    PRIMARY KEY (task_id, day)
);

CREATE TABLE costs (
    task_id         TEXT REFERENCES tasks(id),
    kind            TEXT NOT NULL, -- model, platform_fee, gas_fee
    amount_usd      NUMERIC NOT NULL
);

CREATE TABLE revenues (
    task_id         TEXT REFERENCES tasks(id),
    amount_usd      NUMERIC NOT NULL,
    connector_name  TEXT REFERENCES connectors(name)
);

CREATE TABLE payments (
    id              SERIAL PRIMARY KEY,
    task_id         TEXT REFERENCES tasks(id),
    direction       TEXT NOT NULL, -- inbound, outbound
    amount_usd      NUMERIC NOT NULL,
    connector_name  TEXT REFERENCES connectors(name),
    tx_reference    TEXT, -- e.g. Solana signature
    status          TEXT NOT NULL
);

CREATE TABLE reputation (
    connector_name  TEXT REFERENCES connectors(name),
    score           NUMERIC,
    updated_at      TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (connector_name)
);

CREATE TABLE reviews (
    id              SERIAL PRIMARY KEY,
    task_id         TEXT REFERENCES tasks(id),
    connector_name  TEXT REFERENCES connectors(name),
    rating          NUMERIC,
    comment         TEXT
);

CREATE TABLE memory (
    hash_key            TEXT PRIMARY KEY,
    capability          TEXT REFERENCES capabilities(name),
    prompt              TEXT NOT NULL,
    result              TEXT NOT NULL,
    confidence          NUMERIC,
    source              TEXT,
    verification_status TEXT NOT NULL, -- passed, failed, unverified
    created_at          TIMESTAMP NOT NULL DEFAULT now(),
    expires_at           TIMESTAMP
);

CREATE TABLE semantic_cache (
    hash_key        TEXT REFERENCES memory(hash_key),
    embedding       VECTOR, -- pgvector or equivalent in a real deployment
    PRIMARY KEY (hash_key)
);

CREATE TABLE knowledge_sources (
    id              SERIAL PRIMARY KEY,
    connector_name  TEXT REFERENCES connectors(name),
    url             TEXT,
    fetched_at      TIMESTAMP NOT NULL DEFAULT now(),
    trust_level     TEXT NOT NULL DEFAULT 'untrusted'
);

CREATE TABLE audit_logs (
    id              SERIAL PRIMARY KEY,
    agent_id        TEXT REFERENCES agents(id),
    task_id         TEXT,
    connector_name  TEXT,
    action          TEXT NOT NULL,
    resource        TEXT,
    permission      TEXT,
    result          TEXT,
    risk_level      TEXT,
    approval_status TEXT,
    token_usage     INTEGER,
    cost_usd        NUMERIC,
    error           TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE security_events (
    id              SERIAL PRIMARY KEY,
    task_id         TEXT,
    event_type      TEXT NOT NULL, -- prompt_injection_flagged, credential_exposure_attempt, kill_switch_triggered
    detail          TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
    id              SERIAL PRIMARY KEY,
    task_id         TEXT REFERENCES tasks(id),
    action          TEXT NOT NULL,
    risk_level      TEXT NOT NULL,
    status          TEXT NOT NULL, -- pending, approved, denied
    requested_at    TIMESTAMP NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMP,
    resolved_by     TEXT
);

CREATE TABLE learning_events (
    id              SERIAL PRIMARY KEY,
    event_type      TEXT NOT NULL, -- task_discovered, task_accepted, bid_won, task_completed, task_failed
    connector_name  TEXT REFERENCES connectors(name),
    model           TEXT,
    revenue_usd     NUMERIC,
    cost_usd        NUMERIC,
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE improvement_proposals (
    id              SERIAL PRIMARY KEY,
    description     TEXT NOT NULL,
    status          TEXT NOT NULL, -- proposed, tested, approved, deployed, rolled_back
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    deployed_at     TIMESTAMP
);

CREATE TABLE platform_accounts (
    connector_name  TEXT REFERENCES connectors(name),
    account_ref     TEXT NOT NULL, -- e.g. Colony username, Solana pubkey, Azure app client_id
    status          TEXT NOT NULL,
    PRIMARY KEY (connector_name, account_ref)
);
