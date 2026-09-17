"use strict";

const UniversalAgent = require("./core/universalAgent");
const ColonyConnector = require("./connectors/colony");
const ArtifactCouncilConnector = require("./connectors/artifactCouncil");
const AgencConnector = require("./connectors/agenc");
const AgentBazaarConnector = require("./connectors/agentBazaar");
const AzureMarketplaceConnector = require("./connectors/azureMarketplace");
const OpenTaskConnector = require("./connectors/openTask");
const MoltMarketConnector = require("./connectors/moltMarket");
const GithubConnector = require("./connectors/github");
const McpClient = require("./connectors/mcpClient");
const A2aClient = require("./connectors/a2aClient");

function buildAgent() {
  const persistDir = process.env.PERSIST_DIR || null;
  const agent = new UniversalAgent(persistDir ? { persistDir } : {});

  const colony = new ColonyConnector();
  agent.connectors.register("colony", {
    instance: colony,
    capabilities: ["searchPosts", "postFinding", "commentOnPost", "sendMessage"],
    statusFn: () => colony.status(),
  });

  const artifactCouncil = new ArtifactCouncilConnector();
  agent.connectors.register("artifactCouncil", {
    instance: artifactCouncil,
    capabilities: ["browseDirectory", "getArtifact"],
    statusFn: () => artifactCouncil.status(),
  });

  const agenc = new AgencConnector();
  agent.connectors.register("agenc", {
    instance: agenc,
    capabilities: ["fetchIncomingTasks", "submitDeliverable"],
    statusFn: () => agenc.status(),
  });

  const agentBazaar = new AgentBazaarConnector();
  agent.connectors.register("agentBazaar", {
    instance: agentBazaar,
    capabilities: ["fetchIncomingTasks", "submitDeliverable", "stats"],
    statusFn: () => agentBazaar.status(),
  });

  const azure = new AzureMarketplaceConnector();
  agent.connectors.register("azureMarketplace", {
    instance: azure,
    capabilities: ["fetchIncomingTasks", "submitDeliverable"],
    statusFn: () => azure.status(),
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
    capabilities: github.capabilities,
    statusFn: () => github.status(),
  });

  const moltMarket = new MoltMarketConnector();
  agent.connectors.register("moltMarket", {
    instance: moltMarket,
    capabilities: ["checkHealth", "browseOffers", "browseJobs", "getJob", "publishOffer", "createJob", "bidOnJob", "deliverWork", "approveDelivery", "getMyNotifications"],
    statusFn: () => moltMarket.status(),
  });

  const mcp = new McpClient({ serverUrl: process.env.MCP_SERVER_URL, allowedTools: (process.env.MCP_ALLOWED_TOOLS || "").split(",").filter(Boolean) });
  agent.connectors.register("mcp", {
    instance: mcp,
    capabilities: ["USE_MCP_TOOL"],
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

async function main() {
  const agent = buildAgent();

  console.log("=== Universal Digital Agent — connector status ===");
  console.log(JSON.stringify(agent.connectors.list(), null, 2));

  const demoTask = {
    id: "demo-task-1",
    type: "research_report",
    input: { topic: process.argv[2] || "the current state of AI agent marketplaces" },
  };

  console.log(`\n=== Processing ${demoTask.id} ===`);
  const result = await agent.processTask(demoTask);
  console.log(JSON.stringify(result, null, 2));

  console.log("\n=== Dashboard ===");
  console.log(JSON.stringify(agent.dashboard(), null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { buildAgent, MarketplacePipeline: require("./core/marketplacePipeline") };
