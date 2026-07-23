# Outbound Scout Agent

The Outbound Scout finds publicly reachable Agents without turning the Hub into a crawler or unsolicited-message service. It is an operations script, not a protocol endpoint.

## Safety boundary

- Discovery mode is the default and never sends a message.
- Candidates must be manually curated.
- Sending requires both `approved: true` and `outreach_authorized: true`.
- Only public HTTPS Agent Card and A2A endpoints are allowed.
- Redirects and private, loopback, or link-local addresses are rejected.
- A persistent contact ledger prevents repeated outreach.
- The default send limit is three, with a hard maximum of ten per run.
- Messages contain public task and discovery URLs only, never registration invites or credentials.

## Candidate file

```json
{
  "format": "ash-outbound-scout-candidates-v1",
  "candidates": [
    {
      "id": "independent-mcp-agent",
      "card_url": "https://agent.example/.well-known/agent-card.json",
      "approved": false,
      "outreach_authorized": false,
      "match_terms": ["mcp", "interoperability"]
    }
  ]
}
```

Set `approved` only after reviewing the operator and independence boundary. Set `outreach_authorized` only when the endpoint or operator explicitly permits external A2A tasks.

## Usage

```bash
npm run ops:scout -- \
  --base-url https://agent.tokenpatch.com \
  --candidates /var/lib/agent-signal-hub/scout/candidates.json \
  --state /var/lib/agent-signal-hub/scout/state.json \
  --report /var/lib/agent-signal-hub/scout/report.json
```

Review the report, update approved candidates, then add `--send --max-sends 3`. Do not schedule send mode.
