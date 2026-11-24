"use strict";

/**
 * Agent Brain — the adaptive decision layer. Deterministic arithmetic over REAL outcomes (no LLM call,
 * no tokens spent): it turns the ledger (economics) and the learning engine's statistics into
 * decisions about WHERE the agent should spend its attempts.
 *
 * What "self-evolution" means here (consistent with the project's rule against self-rewriting code):
 * the agent changes its own behaviour — how many opportunities it takes per connector, which ones it
 * throttles, how much it trusts an advertised reward — from measured results, and persists nothing
 * that is not derived from verified facts. Strategy parameters evolve; the code does not.
 *
 * Anti-fake-profit: an advertised reward is a hope. `realizationRate()` is the share of mature
 * (past-grace) expected revenue that was actually paid, shrunk toward a conservative prior while data
 * is thin. Opportunity value is multiplied by it, so a connector that promises a lot and never pays
 * stops looking attractive, and its LLM drafts (tokens) stop being spent on it.
 */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const DEFAULTS = {
  priorRealization: Number(process.env.BRAIN_PRIOR_REALIZATION || 0.5), // trust in advertised rewards with no data
  priorWeightUsd: Number(process.env.BRAIN_PRIOR_WEIGHT_USD || 1), // $ of "virtual evidence" behind the prior
  minRealization: 0.02,
  minSamples: Number(process.env.BRAIN_MIN_SAMPLES || 8), // mature deliveries before a connector can be judged
  probeEveryNCycles: Number(process.env.BRAIN_PROBE_EVERY || 4), // a throttled connector is still probed now and then
  bidPatience: Number(process.env.BRAIN_BID_PATIENCE || 24), // bids with zero observed wins AND zero payments before throttling
  maxBoost: 2, // never more than 2x the base opportunities per cycle
};

class AgentBrain {
  /**
   * @param {{ economics: object, learning: object, now?: () => number, config?: object }} deps
   */
  constructor({ economics, learning, now = () => Date.now(), config = {} } = {}) {
    this.economics = economics;
    this.learning = learning;
    this._now = now;
    this.cfg = { ...DEFAULTS, ...config };
    this._cycleCount = new Map(); // connector -> cycles seen in this process (drives probing)
    this._lastPlan = new Map();
  }

  _perf(connector) {
    return (this.economics && this.economics.connectorPerformance({ now: this._now() })[connector]) || null;
  }

  /** Share of advertised reward that really gets paid on this connector, in [minRealization, 1]. */
  realizationRate(connector) {
    const p = this._perf(connector);
    const { priorRealization: p0, priorWeightUsd: k, minRealization } = this.cfg;
    if (!p) return p0;
    const r = (p.paidUsd + p0 * k) / (p.matureExpectedUsd + k);
    return clamp(r, minRealization, 1);
  }

  /** Average real LLM spend per delivered task on this connector (0 when everything ran in a free tier). */
  avgCostUsd(connector) {
    const p = this._perf(connector);
    return p && p.completed > 0 ? p.costUsd / p.completed : 0;
  }

  /**
   * Decides what the pipeline does with `strategy` this cycle.
   * @returns {{ run: boolean, maxOpportunities: number, minExpectedValue: number, mode: string, reason: string, realizationRate: number }}
   */
  planCycle(strategy, { maxOpportunities = 1, minExpectedValue = 0 } = {}) {
    const connector = strategy.connectorName;
    const n = (this._cycleCount.get(connector) || 0) + 1;
    this._cycleCount.set(connector, n);
    const base = { maxOpportunities, minExpectedValue, realizationRate: this.realizationRate(connector) };
    const done = (plan) => { this._lastPlan.set(connector, { ...plan, at: this._now() }); return plan; };

    // Reputation/social strategies earn no money by design: ROI throttling does not apply to them.
    if (strategy.reputationOnly || !this.economics) return done({ ...base, run: true, mode: "reputation", reason: "not revenue-judged" });

    const p = this._perf(connector);
    // Bid-style connectors deliver nothing until a bid is accepted: judge them on attempts/wins/payments.
    const st = (this.learning && this.learning.connectorStats && this.learning.connectorStats[connector]) || { attempts: 0, wins: 0 };
    if (st.attempts >= this.cfg.bidPatience && st.wins === 0 && !(p && p.paidUsd > 0)) {
      if (n % this.cfg.probeEveryNCycles === 1) {
        return done({ ...base, run: true, maxOpportunities: 1, mode: "probe", reason: `${st.attempts} bids, no accepted bid and no payment — probing with 1` });
      }
      return done({ ...base, run: false, maxOpportunities: 0, mode: "throttled", reason: `${st.attempts} bids, no accepted bid and no payment — no tokens spent this cycle` });
    }
    const mature = p ? p.completed : 0;
    if (!p || mature < this.cfg.minSamples) {
      return done({ ...base, run: true, mode: "explore", reason: `collecting evidence (${mature}/${this.cfg.minSamples} deliveries)` });
    }

    // Judged: has this connector ever turned work into real money?
    if (p.matureExpectedUsd > 0 && p.paidUsd === 0 && p.expectedUsd > 0) {
      if (n % this.cfg.probeEveryNCycles === 1) {
        return done({ ...base, run: true, maxOpportunities: 1, mode: "probe", reason: `${mature} deliveries, $0 paid of $${p.matureExpectedUsd} expected — probing with 1` });
      }
      return done({ ...base, run: false, maxOpportunities: 0, mode: "throttled", reason: `${mature} deliveries, $0 paid of $${p.matureExpectedUsd} expected — no tokens spent this cycle` });
    }

    // Profitable (or unproven-but-not-hopeless): scale by realization relative to the prior.
    const scale = clamp(base.realizationRate / this.cfg.priorRealization, 0.5, this.cfg.maxBoost);
    const max = Math.max(1, Math.round(maxOpportunities * scale));
    return done({ ...base, run: true, maxOpportunities: max, mode: scale > 1 ? "boost" : scale < 1 ? "reduce" : "steady", reason: `realization ${(base.realizationRate * 100).toFixed(0)}% of advertised reward` });
  }

  /** Per-connector report for the dashboard / operator: facts, the current decision, and why. */
  report() {
    const perf = (this.economics && this.economics.connectorPerformance({ now: this._now() })) || {};
    const out = {};
    for (const [c, p] of Object.entries(perf)) {
      out[c] = {
        delivered: p.completed,
        failed: p.failed,
        expectedUsd: p.expectedUsd,
        paidUsd: p.paidUsd,
        costUsd: p.costUsd,
        tokens: p.tokens,
        profitUsd: p.profitUsd,
        realizationRate: this.realizationRate(c),
        tokensPerPaidUsd: p.paidUsd > 0 ? Math.round(p.tokens / p.paidUsd) : null,
        lastDecision: this._lastPlan.get(c) || null,
      };
    }
    return {
      connectors: out,
      overdueExpectedUsd: this.economics ? this.economics.overdueExpectedUsd({ now: this._now() }) : 0,
      note: "Profit counts only confirmed payments. 'expected' is an advertised reward and is never income.",
    };
  }
}

module.exports = AgentBrain;
module.exports.DEFAULTS = DEFAULTS;
