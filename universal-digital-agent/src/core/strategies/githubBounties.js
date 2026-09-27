"use strict";

/**
 * GitHub Bounties strategy for MarketplacePipeline — real, paid open-source
 * work via Algora (https://algora.io), the most established GitHub-native
 * bounty platform. No separate API key needed: bounties live as normal
 * public GitHub issues that Algora's bot has labeled/commented on with a
 * dollar amount, and are claimed with normal GitHub actions (a comment,
 * then a pull request) — all through the GITHUB_TOKEN already configured.
 *
 * IMPORTANT — this strategy is intentionally scoped to the SAFE half of
 * the workflow only:
 *   1. Discover open bounty issues across public GitHub (search API).
 *   2. Draft an "/attempt" comment (implementation plan) — this is the
 *      "communication" capability, same risk tier as every other
 *      strategy in this project.
 *   3. On approval, post that comment to the real issue.
 *
 * It deliberately does NOT write code or open a pull request
 * automatically. Actually solving the bounty (reading the repo, making
 * the fix, opening a PR with "/claim #<number>" in the body) is a much
 * bigger, higher-risk autonomous action than anything else this project
 * does today, and is left as a manual next step once the agent has
 * signaled interest. Treat a submitted "/attempt" as a lead, not a
 * finished job.
 *
 * FIX — owner/repo/number extraction:
 * The previous version only looked at `raw.repository_url` and `raw.number`
 * — but GitHub's search-issues response doesn't always populate
 * `repository_url` on the object as returned to callers (some code paths
 * strip it, some endpoints rename it). Symptom in production:
 *   github createIssueComment → ERROR
 *   (Could not determine owner/repo for issue undefined — skipping comment.)
 * The two fallbacks below try every known field name for the repo URL and
 * the issue number before giving up, and toTask() now logs exactly which
 * fields were missing when extraction fails — so a future failure names
 * the missing field instead of printing `undefined`.
 */

const MIN_BOUNTY_USD = Number(process.env.GITHUB_BOUNTY_MIN_USD || 20);

function parseBountyUsd(issue) {
  const text = `${issue.title || ""} ${issue.body || ""}`;
  const match = text.match(/\$(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/**
 * Extract { owner, repo, number } from a GitHub issue object, trying every
 * documented field name. Returns null on any missing piece, plus the
 * reason, so the caller can log a precise diagnostic instead of `undefined`.
 *
 * GitHub API reference (search issues response) — relevant fields:
 *   repository_url: "https://api.github.com/repos/OWNER/REPO"
 *   html_url:       "https://github.com/OWNER/REPO/issues/NUMBER"
 *   url:            "https://api.github.com/repos/OWNER/REPO/issues/NUMBER"
 *   number:         NUMBER (integer)
 */
function extractRepoIdentity(raw) {
  const repoUrlCandidates = [
    raw.repository_url,
    raw.repository?.url,
    raw.repository?.html_url,
    raw.url,       // api.github.com/repos/OWNER/REPO/issues/N
    raw.html_url,  // github.com/OWNER/REPO/issues/N
  ].filter((v) => typeof v === "string" && v.length > 0);

  let owner = null;
  let repo = null;
  for (const url of repoUrlCandidates) {
    // Try the API shape first: /repos/OWNER/REPO
    let m = url.match(/\/repos\/([^/]+)\/([^/?#]+)/);
    if (!m) {
      // Then the HTML shape: github.com/OWNER/REPO
      m = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    }
    if (m) {
      owner = m[1];
      repo = m[2];
      break;
    }
  }

  // The issue number can be a top-level integer, or the trailing segment
  // of any of the same URLs.
  let number = null;
  if (Number.isInteger(raw.number)) {
    number = raw.number;
  } else if (typeof raw.number === "string" && /^\d+$/.test(raw.number)) {
    number = Number(raw.number);
  } else {
    for (const url of repoUrlCandidates) {
      const m = url.match(/\/issues\/(\d+)/) || url.match(/\/(\d+)\/?$/);
      if (m) {
        number = Number(m[1]);
        break;
      }
    }
  }

  const missing = [];
  if (!owner) missing.push("owner (repository_url/repository.url/url/html_url)");
  if (!repo) missing.push("repo (repository_url/repository.url/url/html_url)");
  if (!number) missing.push("number (raw.number or trailing /issues/N)");

  return { owner, repo, number, missing };
}

const githubBountiesStrategy = {
  connectorName: "github",

  discoverOperation: "searchIssues",
  discoverPermission: "READ_PUBLIC_WEB",
  discover: async (connector) => {
    // "💎" is the emoji Algora's bot uses in its bounty badge comment.
    const issues = await connector.searchIssues('is:issue is:open "💎" in:comments', { limit: 20 });
    // Attach the parsed bounty amount so toOpportunity doesn't need to
    // re-fetch anything.
    return issues.map((issue) => ({ ...issue, _bountyUsd: parseBountyUsd(issue) }));
  },

  toOpportunity: (raw) => ({
    id: raw.id,
    type: "github_bounty",
    rewardUsd: typeof raw._bountyUsd === "number" && raw._bountyUsd >= MIN_BOUNTY_USD ? raw._bountyUsd : 0,
    // Real coding work, not just a proposal — success is far less certain
    // than a simple marketplace bid.
    successProbability: Number(process.env.GITHUB_BOUNTY_DEFAULT_WIN_RATE || 0.15),
    estimatedModelCostUsd: 0,
    platformFeeUsd: 0,
    riskLevel: "MEDIUM",
  }),

  toTask: (raw) => {
    const { owner, repo, number, missing } = extractRepoIdentity(raw);

    if (missing.length > 0) {
      // Precise diagnostic — names the exact missing field(s) instead of
      // printing `undefined`, so the next failure is debuggable from logs
      // alone without re-instrumenting the code.
      console.warn(
        `[githubBounties] Cannot build task for issue id=${raw.id} title="${(raw.title || "").slice(0, 60)}": missing ${missing.join(", ")}.`
      );
    }

    return {
      id: `github-bounty-attempt-${raw.id}`,
      type: "communication",
      input: {
        context: `Open Algora bounty on GitHub — "${raw.title}" (${owner || "?"}/${repo || "?"}#${number || "?"}). Amount: $${raw._bountyUsd ?? "unspecified"}. Issue body: ${(raw.body || "n/a").slice(0, 800)}`,
        goal:
          'Draft a short "/attempt" comment for this GitHub issue: start the comment with "/attempt #' +
          (number || raw.id) +
          '" on its own line, then 2-4 sentences outlining a concrete implementation plan. Do not write actual code.',
        // Store the resolved identity alongside the raw object so submit()
        // does not have to re-derive it (and gets the exact same values
        // that were used to build the goal text above).
        raw: { ...raw, owner, repo, number },
      },
      untrustedContent: raw.body,
      untrustedSource: "github-issue-body",
      sourceConnector: "github",
    };
  },

  submitOperation: "createIssueComment",
  submitPermission: "SUBMIT_TASK",
  submit: (connector, raw, commentText) => {
    // raw.owner/raw.repo/raw.number were resolved by toTask() and travel
    // with the task. If they're still missing here, something upstream
    // dropped them — fail loudly with a specific message.
    if (!raw.owner || !raw.repo) {
      throw new Error(
        `Could not determine owner/repo for issue id=${raw.id} number=${raw.number} — skipping comment. ` +
          `Check that the search-issues response includes repository_url, repository.url, url, or html_url.`
      );
    }
    if (!raw.number) {
      throw new Error(
        `Could not determine issue number for issue id=${raw.id} (owner=${raw.owner}, repo=${raw.repo}) — skipping comment.`
      );
    }
    return connector.createIssueComment(raw.owner, raw.repo, raw.number, commentText);
  },
};

module.exports = githubBountiesStrategy;
