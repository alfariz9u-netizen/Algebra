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
    capabilities: ["searchPosts", "postFinding", "commentOnPost", "sendMessage"],
    statusFn: () => colony.status(),
  });

  // CONFIRMED from artifactCouncil.js: exposes browseDirectory + getArtifact.
  const artifactCouncil = new ArtifactCouncilConnector();
  agent.connectors.register("artifactCouncil", {
    instance: artifactCouncil,
    capabilities: ["browseDirectory", "getArtifact"],
    statusFn: () => artifactCouncil.status(),
  });

  // CONFIRMED from the strategy using fetchIncomingTasks/submitDeliverable.
  const agenc = new AgenCConnector();
  agent.connectors.register("agenc", {
    instance: agenc,
    capabilities: ["fetchIncomingTasks", "submitDeliverable"],
    statusFn: () => agenc.status(),
  });

  // CONFIRMED from agentBazaar.js: exposes fetchIncomingTasks, submitDeliverable, stats.
  const agentBazaar = new AgentBazaarConnector();
  agent.connectors.register("agentBazaar", {
    instance: agentBazaar,
    capabilities: ["fetchIncomingTasks", "submitDeliverable", "stats"],
    statusFn: () => agentBazaar.status(),
  });

  const azureMarketplace = new AzureMarketplaceConnector();
  agent.connectors.register("azureMarketplace", {
    instance: azureMarketplace,
    capabilities: ["discoverTasks", "submitDeliverable"],
    statusFn: () => azureMarketplace.status(),
  });

  // CONFIRMED from openTask.js: discoverTasks, getTask, submitBid, submitDeliverable.
  const openTask = new OpenTaskConnector();
  agent.connectors.register("openTask", {
    instance: openTask,
    capabilities: ["discoverTasks", "getTask", "submitBid", "submitDeliverable"],
    statusFn: () => openTask.status(),
  });

  const github = new GithubConnector();
  agent.connectors.register("github", {
    instance: github,
    capabilities: ["searchRepos", "searchIssues", "createIssueComment"],
    statusFn: () => github.status(),
  });

  // CONFIRMED from moltMarket.js: the full method list below.
  const moltMarket = new MoltMarketConnector();
  agent.connectors.register("moltMarket", {
    instance: moltMarket,
    capabilities: [
      "browseJobs",
      "getJob",
      "bidOnJob",
      "deliverWork",
      "checkHealth",
      "browseOffers",
      "publishOffer",
      "createJob",
      "approveDelivery",
      "getMyNotifications",
      "getMyReviews",
      "getMyPayments",
      "getMyRevenue",
    ],
    statusFn: () => moltMarket.status(),
  });

  // CONFIRMED from moltJobs.js: heartbeat, discoverJobs, getJob, whoami,
  // applyToJob, submitWork, getWallet.
  const moltJobs = new MoltJobsConnector();
  agent.connectors.register("moltJobs", {
    instance: moltJobs,
    capabilities: [
      "heartbeat",
      "discoverJobs",
      "getJob",
      "whoami",
      "applyToJob",
      "submitWork",
      "getWallet",
    ],
    statusFn: () => moltJobs.status(),
  });

  // CONFIRMED from agentMarket.js: discoverTasks, getTask, whoami, getWallet,
  // bidOnTask, listBids, acceptTask, completeTask.
  const agentMarket = new AgentMarketConnector();
  agent.connectors.register("agentMarket", {
    instance: agentMarket,
    capabilities: [
      "discoverTasks",
      "getTask",
      "whoami",
      "getWallet",
      "bidOnTask",
      "listBids",
      "acceptTask",
      "completeTask",
    ],
    statusFn: () => agentMarket.status(),
  });

  // UNCONFIRMED — assume discoverJobs / submitBid / deliverJob for now.
  // If TokuAgency strategy complains about "getJob" or "getProfile",
  // add those to the list (the strategy file referenced them earlier).
  const tokuAgency = new TokuAgencyConnector();
  agent.connectors.register("tokuAgency", {
    instance: tokuAgency,
    capabilities: ["discoverJobs", "getJob", "getProfile", "submitBid", "deliverJob"],
    statusFn: () => tokuAgency.status(),
  });

  const mcp = new McpClient({
    serverUrl: process.env.MCP_SERVER_URL,
    allowedTools: (process.env.MCP_ALLOWED_TOOLS || "").split(",").filter(Boolean),
  });
  agent.connectors.register("mcp", {
    instance: mcp,
    capabilities: ["listTools", "callTool"],
    statusFn: () => mcp.status(),
  });

  // CONFIRMED from a2aClient.js: fetchAgentCard, validateAgentCard, sendMessage.
  const a2a = new A2aClient();
  agent.connectors.register("a2a", {
    instance: a2a,
    capabilities: ["fetchAgentCard", "validateAgentCard", "sendMessage"],
    statusFn: () => a2a.status(),
  });

  return agent;
}

module.exports = { buildAgent, MarketplacePipeline: require("./core/marketplacePipeline") };
