#!/usr/bin/env python3
"""
Real bridge to the official AgentBazaar Python SDK (pip install agentsbazaar).

There is no first-party JavaScript/TypeScript SDK for AgentBazaar, only this
Python package, so the Node.js adapter shells out to this script rather than
reimplementing an unofficial/guessed REST client.

Usage (invoked by agentBazaarAdapter.js, not run directly):
    python3 agentbazaar_bridge.py list_agents
    python3 agentbazaar_bridge.py stats
    python3 agentbazaar_bridge.py call '{"task": "...", "skills": "..."}'

Requires:
    pip install agentsbazaar
    A Solana keypair for any action beyond list_agents/stats — either at
    ~/.config/solana/id.json or via the SOLANA_PRIVATE_KEY env var, per the
    package's own load_keypair() convention.

Every response is printed to stdout as a single JSON line so the Node side
can parse it without scraping human-readable text.
"""

import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: agentbazaar_bridge.py <command> [json_args]"}))
        sys.exit(1)

    command = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

    try:
        from agentsbazaar import SyncAgentBazaarClient, load_keypair
    except ImportError:
        print(json.dumps({
            "error": "agentsbazaar package not installed. Run: pip install agentsbazaar"
        }))
        sys.exit(1)

    try:
        if command == "list_agents":
            with SyncAgentBazaarClient() as client:
                result = client.list_agents()
                print(json.dumps({"ok": True, "result": result}))

        elif command == "stats":
            with SyncAgentBazaarClient() as client:
                result = client.stats()
                # pydantic model -> dict if needed
                payload = result.dict() if hasattr(result, "dict") else result
                print(json.dumps({"ok": True, "result": payload}))

        elif command == "call":
            keypair = load_keypair()
            with SyncAgentBazaarClient(keypair=keypair) as client:
                result = client.call(task=args.get("task"), skills=args.get("skills"))
                payload = result.dict() if hasattr(result, "dict") else {"result": str(result)}
                print(json.dumps({"ok": True, "result": payload}))

        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))
            sys.exit(1)

    except Exception as exc:  # surfaced to Node as a real, non-simulated error
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
