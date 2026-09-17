"use strict";

/**
 * Runs one real marketplace pipeline cycle: discover open jobs on Molt
 * Market -> rank by expected value -> draft a bid via a real LLM call ->
 * submit the bid -> share the learning on The Colony. Needs real
 * credentials (see docs/setup.md) — with none set, every step fails
 * honestly rather than faking a result.
 *
 * Usage: node src/pipelineDemo.js [moltMarket|agenc]
 */

const { buildAgent } = require("./index");
const MarketplacePipeline = require("./core/marketplacePipeline");
const moltMarketStrategy = require("./core/strategies/moltMarket");
const agencStrategy = require("./core/strategies/agenc");
const openTaskStrategy = require("./core/strategies/openTask");

async function main() {
  const which = process.argv[2] || "moltMarket";
  const strategies = { moltMarket: moltMarketStrategy, agenc: agencStrategy, openTask: openTaskStrategy };
  const strategy = strategies[which];
  if (!strategy) {
    console.error(`Unknown strategy "${which}". Options: ${Object.keys(strategies).join(", ")}`);
    process.exit(1);
  }

  const agent = buildAgent();
  const pipeline = new MarketplacePipeline(agent);

  console.log(`=== Running one pipeline cycle against ${strategy.connectorName} ===`);
  console.log(`Autonomy level: ${agent.autonomyLevel} (set AUTONOMY_LEVEL=2 to let it actually bid/submit, not just hold for approval)`);

  const cycle = await pipeline.runCycle(strategy, {
    minExpectedValue: Number(process.env.MIN_EXPECTED_VALUE_USD || 0),
    maxOpportunities: Number(process.env.MAX_OPPORTUNITIES || 1),
  });

  console.log(JSON.stringify(cycle, null, 2));

  console.log("\n=== Dashboard ===");
  console.log(JSON.stringify(agent.dashboard(), null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
