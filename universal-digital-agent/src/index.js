"use strict";

const UniversalAgent = require("./core/universalAgent");
const ColonyConnector = require("./connectors/colony");
const ArtifactCouncilConnector = require("./connectors/artifactCouncil");
const AgenCConnector = require("./connectors/agenc");
const AgentBazaarConnector = require("./connectors/agentBazaar");
const AzureMarketplaceConnector = require("./connectors/azureMarketplace");
const OpenTaskConnector = require("./connectors/openTask");
const GithubConnector = require("./connectors/github");
const MoltMarketConnector = require("./connectors/moltMarket");
const MoltJobsConnector = require("./connectors/moltJobs");
const AgentMarketConnector = require("./connectors/agentMarket");
const TokuAgencyConnector = require("./connectors/tokuAgency");
const McpClient = require("./connectors/mcpClient");
const A2aClient = require("./connectors/a2aClient");
const MoltbookConnector = require("./connectors/moltbook");
const SupabaseConnector = require("./connectors/supabase");
const AgentverseConnector = require("./connectors/agentverse");

// FIX (PERSIST_DIR consistency on Render/production): this used to pass
// `process.env.PERSIST_DIR` straight through with NO fallback. Several
// OTHER modules (llmPricing.js's quota tracker, strategies/moltbook.js's
// and strategies/agentBazaar.js's own state files) already independently
// default to "./data" when PERSIST_DIR is unset — but UniversalAgent (and
// everything fed by `this.persistDir` inside it: approvals, economics,
// learning, audit, kill switch, memory) got `undefined` instead, which
// means NO persistence at all, not even same-directory-as-everything-else
// local persistence — a silent, much worse failure mode than "resets on
// restart": approvalCli.js and the Telegram bot literally cannot see
// anything combinedServer.js's own long-running process creates, even
// within the same deployment between restarts, because there was no file
// for them to share in the first place. Resolved ONCE here, with the SAME
// "./data" default every other module already uses (so everything is
// finally guaranteed to share one real directory), and a loud, explicit
// warning when the env var itself was never set — this is exactly the
// kind of silent misconfiguration that should be impossible to miss in
// logs, not something you discover by noticing approvals never resume.
const resolvedPersistDir = process.env.PERSIST_DIR || "./data";
if (!process.env.PERSIST_DIR) {
  console.warn(
    `[index] WARNING: PERSIST_DIR is not set. Falling back to "${resolvedPersistDir}" (relative to the process's working directory). ` +
      "On Render specifically, the local disk is ephemeral by default: anything written to a path that isn't on an attached " +
      "Persistent Disk is LOST on every restart/redeploy — including approvals, economics history, learned circuit-breaker " +
      "state, and moltbook/colony post cooldowns. Set PERSIST_DIR to a path on a real attached disk (e.g. /data) for this to " +
      "actually persist in production."
  );
}

function buildAgent() {
  // تمرير persistDir و encryptionKey من متغيرات البيئة (ضروري لحفظ
  // audit log / approvals / economics / memory على القرص بدلاً من الذاكرة فقط)
  const agent = new UniversalAgent({
    persistDir: resolvedPersistDir,
    encryptionKey: process.env.PERSIST_ENCRYPTION_KEY,
  });

  const colony = new ColonyConnector();
  agent.connectors.register("colony", {
    instance: colony,
    capabilities: ["searchPosts", "postFinding", "commentOnPost", "sendMessage"],
    statusFn: () => colony.status(),
  });

  const artifactCouncil = new ArtifactCouncilConnector();
  agent.connectors.register("artifactCouncil", {
    instance: artifactCouncil,
    capabilities: ["discoverTasks", "submitDeliverable"],
    statusFn: () => artifactCouncil.status(),
  });

  const agenc = new AgenCConnector();
  agent.connectors.register("agenc", {
    instance: agenc,
    capabilities: ["fetchIncomingTasks", "submitDeliverable"],
    statusFn: (operation) => agenc.status(operation),
  });

  const agentBazaar = new AgentBazaarConnector();
  agent.connectors.register("agentBazaar", {
    instance: agentBazaar,
    capabilities: ["fetchIncomingTasks", "submitDeliverable"],
    statusFn: (operation) => agentBazaar.status(operation),
  });

  const azureMarketplace = new AzureMarketplaceConnector();
  agent.connectors.register("azureMarketplace", {
    instance: azureMarketplace,
    capabilities: ["discoverTasks", "submitDeliverable"],
    statusFn: () => azureMarketplace.status(),
  });

  const openTask = new OpenTaskConnector();
  agent.connectors.register("openTask", {
    instance: openTask,
    capabilities: ["discoverTasks", "submitBid", "submitDeliverable"],
    statusFn: () => openTask.status(),
  });

  const github = new GithubConnector();
  agent.connectors.register("github", {
    instance: github,
    capabilities: ["searchRepos", "searchIssues", "createIssueComment"],
    statusFn: () => github.status(),
  });

  const moltMarket = new MoltMarketConnector();
  agent.connectors.register("moltMarket", {
    instance: moltMarket,
    capabilities: ["browseJobs", "bidOnJob"],
    statusFn: () => moltMarket.status(),
  });

  const moltJobs = new MoltJobsConnector();
  agent.connectors.register("moltJobs", {
    instance: moltJobs,
    capabilities: ["heartbeat", "discoverJobs", "applyToJob", "submitWork"],
    statusFn: () => moltJobs.status(),
  });

  const agentMarket = new AgentMarketConnector();
  agent.connectors.register("agentMarket", {
    instance: agentMarket,
    capabilities: ["discoverTasks", "bidOnTask", "acceptTask", "completeTask"],
    statusFn: () => agentMarket.status(),
  });

  const tokuAgency = new TokuAgencyConnector();
  agent.connectors.register("tokuAgency", {
    instance: tokuAgency,
    capabilities: ["discoverJobs", "submitBid", "deliverJob"],
    statusFn: () => tokuAgency.status(),
  });

  // Moltbook (بناء السمعة: تصويت + تعليق + نشر)
  const moltbook = new MoltbookConnector();
  agent.connectors.register("moltbook", {
    instance: moltbook,
    capabilities: [
      "getFeed",
      "getPost",
      "getComments",
      "whoami",
      "upvotePost",
      "downvotePost",
      "commentOnPost",
      "createPost",
    ],
    statusFn: () => moltbook.status(),
  });

  // Supabase (الذاكرة الدلالية طويلة المدى)
  const supabase = new SupabaseConnector();
  agent.connectors.register("supabase", {
    instance: supabase,
    capabilities: ["storeLesson", "searchLessons", "countLessons"],
    statusFn: () => supabase.status(),
  });

  // Agentverse (Fetch.ai): a directory/identity registry, not a task
  // marketplace — see the long comment at the top of connectors/agentverse.js
  // for why it has no discover/bid/submit strategy and isn't in
  // combinedServer.js's STRATEGIES list. "register" needs a real signed
  // identity (AGENTVERSE_AGENT_SEED); "listAgents" (the Search API) only
  // needs the API key — hence the per-operation statusFn.
  const agentverse = new AgentverseConnector();
  agent.connectors.register("agentverse", {
    instance: agentverse,
    capabilities: ["register", "listAgents"],
    statusFn: (operation) => agentverse.status(operation),
  });

  const mcp = new McpClient({ serverUrl: process.env.MCP_SERVER_URL, allowedTools: (process.env.MCP_ALLOWED_TOOLS || "").split(",").filter(Boolean) });
  agent.connectors.register("mcp", {
    instance: mcp,
    capabilities: ["listTools", "callTool"],
    statusFn: () => mcp.status(),
  });

  const a2a = new A2aClient();
  agent.connectors.register("a2a", {
    instance: a2a,
    capabilities: ["USE_A2A"],
    statusFn: () => a2a.status(),
  });

  return agent;
}

// تصدير مزدوج لضمان التوافق مع جميع طرق الاستيراد في المشروع
module.exports = buildAgent;
module.exports.buildAgent = buildAgent;
