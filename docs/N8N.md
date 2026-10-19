# Sending call results to n8n

`npm run call` can POST each call's result to an [n8n](https://n8n.io) workflow. It is off unless
`N8N_WEBHOOK_URL` is set. Nothing else in the repo reads that variable, and every other command
behaves the same whether it is set or not.

🔴 **Every result says `"simulated": true` and `"leg": "fake-leg"`.** There is no carrier yet, so
each "call" is a recorded conversation played against nobody. If a workflow sends these anywhere a
person reads them, it should say so too.

## Set it up

1. In n8n, create a workflow and start it with a **Webhook** node. Set the method to `POST`, set
   *Respond* to *Immediately*, and copy the **Production URL**. The Test URL only listens while the
   editor is waiting for one event.
2. Activate the workflow.
3. Run the calls with the URL set:

   ```bash
   N8N_WEBHOOK_URL=https://your-n8n.example/webhook/venue-call-result npm run call
   ```

   ```powershell
   $env:N8N_WEBHOOK_URL = 'https://your-n8n.example/webhook/venue-call-result'; npm run call
   ```

The run prints `n8n: X/Y call result(s) delivered` after the verdict. It prints one
`NOT delivered` line for each failure, giving the HTTP status or transport error code but never the URL.

## What the run guarantees

- **The verdict comes first.** Each call is scored before anything is sent, so a webhook that is
  down cannot change a result. Also, a failed delivery does not change the exit code.
- **A bad URL stops the run before any call starts.** It exits with code 64 and does not echo the
  value.
- **Only `npm run call` sends results.** `--sweep` sends nothing, and so do `npm run eval`, `npm test` and
  `npm run verify`.
- **Each request has a five-second timeout,** and results are sent one at a time, in the order
  the calls ran.

## The payload

The shape is defined in `src/notify/n8n.ts`, which is the source of truth. If this example and that
file ever disagree, the file is right. If a field changes meaning, `schema` is bumped, so the
workflow can check it with an IF node.

```json
{
  "schema": "venue-call-agent.call-result/1",
  "leg": "fake-leg",
  "simulated": true,
  "fixture": "who-pays",
  "scenario": "...",
  "agent": "stub",
  "endedBecause": "agent_ended",
  "verdict": "clean",
  "hardFailures": [],
  "softFailures": [],
  "audio": {
    "callMs": 0, "openingDelayMs": 0, "deadAirP50Ms": 0,
    "maxDeadAirMs": 0, "talkOverFrames": 0, "hangup": "agent_ended"
  },
  "transcript": [{ "who": "venue", "text": "..." }, { "who": "agent", "text": "..." }],
  "sentAt": "2026-10-19T00:00:00.000Z"
}
```

`refusalReason` is present only when the seam refused. `verdict` is `hard` if any hard check
failed, `soft` if only soft checks failed, and `clean` otherwise. These are the same checks
`npm run call` prints.

The n8n expression `{{ $json.body.verdict }}` reads the verdict. The Webhook node puts the
POST body under `body`.

## Tests

`test/n8n.test.ts` runs a real local HTTP server that stands in for n8n. It checks that an
accepted delivery is reported as delivered. It then plants an HTTP 500, a closed port and a server
that never answers, and each of those must come back as **not** delivered.
