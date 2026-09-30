"""
Agentverse identity bridge.

Fetch.ai's Agentverse requires every registered agent to have a real
cryptographic identity: a bech32-encoded address with the "agent" prefix,
derived from a keypair using Fetch.ai's own (Cosmos-style) scheme. That
derivation is genuinely NOT something to hand-roll in JS without their
SDK — getting the curve, hashing, or bech32 encoding subtly wrong would
silently produce an address that Agentverse either rejects outright or
(worse) accepts but can never actually be proven to own later.

Fetch.ai publishes the official implementation as a Python package:
`pip install uagents-core` (https://pypi.org/project/uagents-core/).
This bridge's ONLY job is to call that package for the one thing that
truly needs it — deriving the address (and, if ever needed, signing a
challenge) from an operator-supplied seed phrase. Every other Agentverse
call this project makes (POST /v2/agents to register, POST /v1/search to
discover other agents) is a plain, fully-documented JSON REST call with
a Bearer token, made directly from connectors/agentverse.js — no need to
route those through Python at all, and no guessing involved either way.

Usage (mirrors the existing agentbazaar_bridge.py contract exactly):
    python3 agentverse_bridge.py <command> '<json-args>'
    -> prints exactly one line of JSON: {"result": ...} or {"error": "..."}

Commands:
    address  {"seed": "..."}            -> {"result": {"address": "agent1..."}}
    sign     {"seed": "...", "message_b64": "..."} -> {"result": {"signature": "..."}}
             (not currently called by agentverse.js; provided for any future
             privileged call — e.g. reading this agent's own mailbox — that
             needs a signed challenge per docs.agentverse.ai/api-reference/identity)
"""

import sys
import json
import base64


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: agentverse_bridge.py <command> <json_args>"}))
        return

    command = sys.argv[1]
    try:
        args = json.loads(sys.argv[2])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid JSON args: {e}"}))
        return

    try:
        from uagents_core.identity import Identity
    except ImportError:
        print(json.dumps({
            "error": (
                "uagents-core is not installed. Run: pip install uagents-core "
                "(see https://pypi.org/project/uagents-core/)."
            )
        }))
        return

    seed = args.get("seed")
    if not seed:
        print(json.dumps({"error": "'seed' is required (set AGENTVERSE_AGENT_SEED)."}))
        return

    try:
        # Identity.from_seed(seed, index) is deterministic: the same seed
        # always yields the same address, which is exactly what we want —
        # register once, and every later call derives the same identity
        # without needing to persist a raw private key anywhere ourselves.
        identity = Identity.from_seed(seed, 0)

        if command == "address":
            print(json.dumps({"result": {"address": identity.address}}))
        elif command == "sign":
            message_b64 = args.get("message_b64")
            if not message_b64:
                print(json.dumps({"error": "'message_b64' is required for sign."}))
                return
            message = base64.b64decode(message_b64)
            signature = identity.sign(message)
            print(json.dumps({"result": {"signature": signature, "address": identity.address}}))
        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))
    except Exception as e:  # noqa: BLE001 - this is a bridge boundary; report, don't guess
        print(json.dumps({"error": f"uagents-core error: {e}"}))


if __name__ == "__main__":
    main()
