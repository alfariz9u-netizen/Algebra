-- 001_state_tables.sql
-- Operational state that used to live on Render's ephemeral disk
-- (economic-events.jsonl, economic-rollup.json, approvals.json,
-- learning-state.json, moltbook-state.json). Idempotent: safe to re-run.
-- The agent talks to these tables with SUPABASE_SERVICE_KEY (service_role),
-- which bypasses RLS; RLS is enabled with no policies so the anon/public key
-- can read or write none of it.

-- ---------------------------------------------------------------- economics
create table if not exists public.economic_events (
  id                   uuid primary key,
  "timestamp"          bigint      not null,           -- epoch ms, as recorded by the agent
  type                 text        not null,
  task_id              text,
  connector            text,
  model                text,
  revenue_usd          numeric,
  cost_usd             numeric,
  expected_revenue_usd numeric,
  amount_usd           numeric,
  tx_signature         text,
  metadata             jsonb       not null default '{}'::jsonb,  -- any other event fields
  created_at           timestamptz not null default now()
);

-- One real on-chain payment is counted once: tx_signature is the idempotency
-- second guard for recordPayment() (its main key is (type, task_id)). (Several NULLs are allowed; only real values collide.)
create unique index if not exists economic_events_tx_signature_key
  on public.economic_events (tx_signature);

-- A task's completion/failure is counted once, even across restarts/processes.
create unique index if not exists economic_events_financial_task_key
  on public.economic_events (type, task_id)
  where type in ('task_completed', 'task_failed', 'payment_received') and task_id is not null;

create index if not exists economic_events_timestamp_idx on public.economic_events ("timestamp");

-- Totals of events that prune() removed, so lifetime numbers never shrink.
create table if not exists public.economic_rollup (
  id         int primary key,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

-- prune() must delete the old events AND fold them into the rollup in ONE
-- transaction; doing it as two REST calls could double-count or lose revenue
-- if the second one failed.
create or replace function public.economic_prune(p_ids uuid[], p_rollup jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.economic_rollup (id, data, updated_at)
  values (1, p_rollup, now())
  on conflict (id) do update set data = excluded.data, updated_at = now();

  delete from public.economic_events where id = any(p_ids);
end;
$$;

revoke all on function public.economic_prune(uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.economic_prune(uuid[], jsonb) to service_role;

-- ---------------------------------------------------------------- approvals
create table if not exists public.approvals (
  id            text primary key,
  task_id       text,
  task          jsonb,
  capability    text,
  connector     text,
  action        text,
  risk_level    text,
  status        text        not null default 'pending',
  version       int         not null default 1,   -- optimistic concurrency: UPDATE ... WHERE version = X
  requested_at  timestamptz,
  resolved_at   timestamptz,
  resolved_by   text,
  claimed_at    timestamptz,
  claimed_by    text,
  executing_at  timestamptz,
  consumed_at   timestamptz,
  result        jsonb
);

create index if not exists approvals_status_idx on public.approvals (status);

-- ----------------------------------------------------------- learning state
-- Keys used: 'circuits', 'deadOpportunities', 'connectorStats'.
create table if not exists public.learning_state (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------- moltbook state
-- Key used by the agent's post hook: 'post_state' ({lastPostAt, publishedTitleHashes}).
create table if not exists public.moltbook_state (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------------------- RLS
alter table public.economic_events enable row level security;
alter table public.economic_rollup enable row level security;
alter table public.approvals       enable row level security;
alter table public.learning_state  enable row level security;
alter table public.moltbook_state  enable row level security;
