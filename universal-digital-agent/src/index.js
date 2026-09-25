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

function buildAgent() {
  const agent = new UniversalAgent();

  const colony = new ColonyConnector();
  agent.connectors.register("colony", {
    instance: colony,
    // FIX: ColonyConnector has no .capabilities() method — it never did.
    // This threw "colony.capabilities is not a function" the instant
    // buildAgent() ran, taking down every test/entrypoint that calls it
    // (Telegram bot, A2A server, MCP tool loop, the combined server...).
    // Literal list matching the connector's real methods, same convention
    // as every other connector below.
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
    capabilities: ["discoverTasks", "submitBid"],
    statusFn: () => agenc.status(),
  });

  const agentBazaar = new AgentBazaarConnector();
  agent.connectors.register("agentBazaar", {
    instance: agentBazaar,
    capabilities: ["discoverTasks", "submitBid"],
    statusFn: () => agentBazaar.status(),
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
    // "searchIssues" and "createIssueComment" added for the githubBounties
    // strategy — it shares this same connector/credential (GITHUB_TOKEN)
    // rather than needing a separate one.
    capabilities: ["searchRepos", "searchIssues", "createIssueComment"],
    statusFn: () => github.status(),
  });

  const moltMarket = new MoltMarketConnector();
  agent.connectors.register("moltMarket", {
    instance: moltMarket,
    capabilities: ["discoverJobs", "bidOnJob"],
    statusFn: () => moltMarket.status(),
  });

  // --- Newly registered: these three connector classes already existed in
  // src/connectors/ and their strategies in src/core/strategies/ already
  // referenced them, but nothing wired them into the registry — meaning
  // agent.callConnector("moltJobs"|"agentMarket"|"tokuAgency", ...) would
  // have thrown "Unknown connector" the moment MarketplacePipeline tried
  // to use them. Capabilities lists match each connector's actual method
  // names exactly (this is what callConnector's supports() check matches
  // against — see universalAgent.js).

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

  const mcp = new McpClient({ serverUrl: process.env.MCP_SERVER_URL, allowedTools: (process.env.MCP_ALLOWED_TOOLS || "").split(",").filter(Boolean) });
  agent.connectors.register("mcp", {
    instance: mcp,
    // Operation names (matched by callConnector's supports() check), not the
    // USE_MCP_TOOL permission constant — see universalAgent._executeWithTools.
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

module.exports = { buildAgent, MarketplacePipeline: require("./core/marketplacePipeline") };
