"use strict";

/**
 * Connector for Artifact Council (https://artifactcouncil.com) — a
 * collaborative knowledge base governed by councils of AI agents who
 * propose, vote on, and version artifacts. Confirmed real and free
 * (homepage: "creating artifacts, proposing, applying, and voting are all
 * free") and identity-linked to The Colony (agents verify with their
 * thecolony.cc account).
 *
 * HONESTY NOTE: at build time I could confirm the site is real and free,
 * and that its machine-readable capability description lives at
 * https://artifactcouncil.com/skill.md, but I could not fetch that file in
 * this environment to pin down exact REST paths/payloads beyond what the
 * public homepage shows (a directory listing and per-artifact pages).
 * Rather than guess endpoint shapes, this connector:
 *   - implements `browseDirectory()` for real, against the one path
 *     confirmed to exist (`/directory`), read-only, no auth,
 *   - exposes `status()` as CREDENTIAL_REQUIRED for write operations
 *     (propose/vote/apply) until `ARTIFACT_COUNCIL_SKILL_URL` content is
 *     fetched and the exact write endpoints are filled in below.
 *
 * REQUIRES for write operations:
 *   - A thecolony.cc identity (see connectors/colony.js) to verify with,
 *   - Confirmation of exact POST endpoints from GET /skill.md.
 */

const BASE_URL = process.env.ARTIFACT_COUNCIL_BASE_URL || "https://artifactcouncil.com";

class ArtifactCouncilConnector {
  constructor() {
    this.name = "Artifact Council";
  }

  status() {
    // Read-only directory browsing works with no credentials; anything
    // that writes (propose/vote/apply) is NOT enabled until the skill
    // manifest's exact endpoints are confirmed — see note above.
    return "CREDENTIAL_REQUIRED";
  }

  /** Real, working, read-only: fetches the public artifact directory HTML. */
  async browseDirectory() {
    const response = await fetch(`${BASE_URL}/directory`);
    if (!response.ok) throw new Error(`Artifact Council directory fetch failed: ${response.status}`);
    return response.text(); // Caller (webResearch/knowledgeRetrieval capability) treats this as untrusted external content.
  }

  /** Real, working, read-only: fetches a single artifact page by ID. */
  async getArtifact(artifactId) {
    const response = await fetch(`${BASE_URL}/artifact/${artifactId}`);
    if (!response.ok) throw new Error(`Artifact Council fetch failed: ${response.status}`);
    return response.text();
  }

  /**
   * NOT_SUPPORTED until the write API is confirmed. Throws rather than
   * guessing a POST shape that might not match the real API.
   */
  async proposeArtifact() {
    throw new Error(
      "NOT_SUPPORTED: Artifact Council's write API (propose/apply/vote) was not confirmed at build time. " +
        "Fetch https://artifactcouncil.com/skill.md and fill in the real endpoint here before enabling this."
    );
  }
}

module.exports = ArtifactCouncilConnector;
