"use strict";

/**
 * Real adapter for the Microsoft commercial marketplace (Azure Marketplace /
 * AppSource) SaaS Fulfillment API v2 + Marketplace Metering Service API.
 *
 * Docs used to build this:
 *   https://learn.microsoft.com/azure/marketplace/partner-center-portal/pc-saas-fulfillment-subscription-api
 *   https://learn.microsoft.com/partner-center/marketplace-offers/pc-saas-fulfillment-operations-api
 *   https://learn.microsoft.com/azure/marketplace/marketplace-metering-service-apis
 *
 * IMPORTANT — this is a different shape of "marketplace" than a freelance
 * task board: it's for a published SaaS *offer* with subscribers, not agents
 * claiming one-off gigs. "Incoming tasks" here means pending fulfillment
 * operations (e.g. a customer just subscribed/changed plan) on your offer's
 * active subscriptions; "deliverable" means acknowledging/activating that
 * operation and optionally emitting a usage event for metered billing.
 *
 * REQUIRES (you must supply these — nothing here is simulated):
 *   - AZURE_TENANT_ID       Entra (AAD) tenant ID for your single-tenant app
 *   - AZURE_CLIENT_ID       App registration (client) ID, registered to your
 *                           SaaS offer in Partner Center
 *   - AZURE_CLIENT_SECRET   Client secret for that app registration
 *
 * The publisher must have a real Partner Center account with a published
 * (even $0, preview-stage) transactable SaaS offer — see docs/setup.md.
 */

const API_VERSION = "2018-08-31";
const MARKETPLACE_API_BASE = "https://marketplaceapi.microsoft.com/api";
// Fixed resource ID for the Marketplace Fulfillment API, per Microsoft's docs.
const MARKETPLACE_RESOURCE_ID = "20e940b3-4c77-4b0b-9a53-9e16a1b010a7";

class AzureMarketplaceAdapter {
  constructor() {
    this.name = "Microsoft Commercial Marketplace";
    this._token = null;
    this._tokenExpiry = 0;
  }

  status() {
    return process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET
      ? "CONNECTED"
      : "CREDENTIAL_REQUIRED";
  }

  async _getAccessToken() {
    if (this._token && Date.now() < this._tokenExpiry - 30_000) {
      return this._token;
    }

    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;
    if (!tenantId || !clientId || !clientSecret) {
      throw new Error(
        "Azure Marketplace adapter requires AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET " +
          "from an Entra ID app registration tied to your Partner Center SaaS offer. See docs/setup.md."
      );
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      resource: MARKETPLACE_RESOURCE_ID,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error_description || `Azure AD token request failed: ${response.status}`);
    }

    this._token = data.access_token;
    this._tokenExpiry = Date.now() + Number(data.expires_in || 3600) * 1000;
    return this._token;
  }

  async _authedFetch(path, options = {}) {
    const token = await this._getAccessToken();
    const url = `${MARKETPLACE_API_BASE}${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-ms-requestid": cryptoRandomId(),
        "x-ms-correlationid": cryptoRandomId(),
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(
        `Azure Marketplace API ${options.method || "GET"} ${path} failed: ${response.status} ${JSON.stringify(errBody)}`
      );
    }
    if (response.status === 204) return null;
    return response.json();
  }

  /**
   * Lists active subscriptions, then pending operations for each — this is
   * the closest analogue to "incoming tasks" for a SaaS offer: work items
   * are subscription lifecycle events (subscribe, unsubscribe, change plan),
   * not freelance-style task specs.
   */
  async fetchIncomingTasks() {
    const subsResponse = await this._authedFetch("/saas/subscriptions");
    const subscriptions = subsResponse?.subscriptions || [];

    const tasks = [];
    for (const sub of subscriptions) {
      const opsResponse = await this._authedFetch(`/saas/subscriptions/${sub.id}/operations`);
      const operations = opsResponse?.operations || [];
      for (const op of operations) {
        tasks.push({
          id: op.id,
          type: "business_automation",
          clientLocale: "en-US",
          input: {
            process: `Fulfill ${op.action} for subscription ${sub.id} (plan ${op.planId})`,
            systems: ["Azure Marketplace SaaS Fulfillment API"],
          },
          _marketplaceRaw: { subscription: sub, operation: op },
        });
      }
    }
    return tasks;
  }

  /**
   * Acknowledges the fulfillment operation as completed (Operation Patch API),
   * and — if a usage/billing amount is present in the deliverable — emits a
   * metered usage event via the Marketplace Metering Service API.
   */
  async submitDeliverable(taskId, deliverable) {
    const raw = deliverable._marketplaceRaw;
    if (!raw) {
      throw new Error(
        "submitDeliverable for Azure Marketplace requires the task's original _marketplaceRaw " +
          "(subscription + operation) as returned by fetchIncomingTasks."
      );
    }

    await this._authedFetch(
      `/saas/subscriptions/${raw.subscription.id}/operations/${raw.operation.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "Success" }),
      }
    );

    if (deliverable.usageQuantity) {
      const token = await this._getAccessToken();
      const usageResponse = await fetch(
        `${MARKETPLACE_API_BASE}/usageEvent?api-version=${API_VERSION}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            resourceId: raw.subscription.id,
            quantity: deliverable.usageQuantity,
            dimension: deliverable.usageDimension || "default",
            effectiveStartTime: new Date().toISOString(),
            planId: raw.subscription.planId,
          }),
        }
      );
      if (!usageResponse.ok) {
        const err = await usageResponse.json().catch(() => ({}));
        throw new Error(`Metering API usage event failed: ${usageResponse.status} ${JSON.stringify(err)}`);
      }
    }

    return { accepted: true, taskId };
  }
}

function cryptoRandomId() {
  return require("node:crypto").randomUUID();
}

module.exports = AzureMarketplaceAdapter;
