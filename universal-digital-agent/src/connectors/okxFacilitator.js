"use strict";

/**
 * OKX x402 Facilitator client — lets this agent SELL a paid API service
 * (instead of bidding on other people's tasks). A caller hits our HTTP
 * endpoint, gets a 402 Payment Required with a price quote, pays in USDC
 * on X Layer (OKX's L2, near-zero gas), retries with an X-PAYMENT header,
 * and OKX verifies + settles the on-chain transfer on our behalf.
 *
 * CONFIRMED from OKX's own docs and a real published integration:
 *   - Network: X Layer, chain id 196 -> CAIP-2 "eip155:196"
 *   - USDC contract on X Layer: 0x74b7f16337b8972027f6196a17a631ac6de26d22
 *     (web3.okx.com/onchainos/dev-docs/payments/supported-networks)
 *   - Verify endpoint: POST https://web3.okx.com/api/v6/x402/verify
 *     (confirmed via a real project's documented OKX API usage list)
 *   - Auth: OKX's standard HMAC-SHA256 REST scheme (OK-ACCESS-KEY/SIGN/
 *     TIMESTAMP/PASSPHRASE), the same one their spot-trading API uses —
 *     matches the OKXAuthConfig{api_key, secret_key, passphrase} fields
 *     in OKX's own official x402 seller SDK example.
 *
 * HONESTY NOTE: the /settle endpoint path is inferred by pattern-matching
 * the confirmed /verify path (POST /api/v6/x402/settle) — not directly
 * confirmed. As with every other unconfirmed-shape connector this
 * session, every call below surfaces the full response body on failure,
 * so a wrong guess is immediately visible and fixable from real output
 * instead of another round of blind guessing.
 *
 * REQUIRES: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE, OKX_PAY_TO_ADDRESS
 */

const crypto = require("crypto");

const BASE_URL = process.env.OKX_BASE_URL || "https://web3.okx.com";
const USDC_ON_XLAYER = "0x74b7f16337b8972027f6196a17a631ac6de26d22";
const XLAYER_NETWORK = "eip155:196";

class OKXFacilitator {
  constructor() {
    this.name = "OKX x402 Facilitator";
  }

  status() {
    return process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE && process.env.OKX_PAY_TO_ADDRESS
      ? "CONNECTED"
      : "CREDENTIAL_REQUIRED";
  }

  _authHeaders(method, requestPath, bodyString) {
    if (this.status() !== "CONNECTED") {
      throw new Error("OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE/OKX_PAY_TO_ADDRESS are not fully set.");
    }
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method + requestPath + bodyString;
    const sign = crypto.createHmac("sha256", process.env.OKX_SECRET_KEY).update(prehash).digest("base64");
    return {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": process.env.OKX_API_KEY,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": process.env.OKX_PASSPHRASE,
    };
  }

  async _post(path, bodyObj) {
    const bodyString = JSON.stringify(bodyObj);
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: this._authHeaders("POST", path, bodyString),
      body: bodyString,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`OKX facilitator ${path} failed: ${response.status} ${JSON.stringify(json).slice(0, 400)}`);
    }
    return json;
  }

  /** Builds the PaymentRequirements object to quote in a 402 response. */
  buildRequirements({ priceUsd, resourceUrl, description, maxTimeoutSeconds = 300 }) {
    return {
      scheme: "exact",
      network: XLAYER_NETWORK,
      maxAmountRequired: String(Math.round(priceUsd * 1_000_000)), // USDC has 6 decimals
      resource: resourceUrl,
      description,
      mimeType: "application/json",
      payTo: process.env.OKX_PAY_TO_ADDRESS,
      maxTimeoutSeconds,
      asset: USDC_ON_XLAYER,
      extra: { name: "USDC", decimals: 6 },
    };
  }

  async verify(paymentPayload, paymentRequirements) {
    return this._post("/api/v6/x402/verify", { paymentPayload, paymentRequirements });
  }

  async settle(paymentPayload, paymentRequirements) {
    return this._post("/api/v6/x402/settle", { paymentPayload, paymentRequirements });
  }
}

module.exports = OKXFacilitator;
