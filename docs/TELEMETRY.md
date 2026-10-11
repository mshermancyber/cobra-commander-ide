# Telemetry

**Cobra Commander collects nothing.** There is no telemetry module in this release, no analytics
endpoint, no usage reporting and no crash reporting. Nothing phones home.

You can verify it:

```bash
grep -ri telemetry src/     # no implementation
```

## What does leave your machine

One thing, and only because you asked for it: **the model API calls you configure.**

When a worker or the orchestrator runs, it sends to the gateway at `OPENAI_BASE_URL`:

- the task description you wrote,
- the contents of files the agent chose to read,
- command output the agent chose to run,
- its own reasoning and tool calls,
- and, if security scanning is enabled, the findings — which may quote vulnerable source, and in the
  case of secret-scanning findings may contain live credentials.

That traffic goes to whichever endpoint you configured and nowhere else. Choose it with the same care
you would apply to any other place your source code goes. A local runtime (`OPENAI_BASE_URL` pointing
at Ollama or vLLM) keeps everything on your own hardware.

## Local state written to disk

| Path | Contents |
|------|----------|
| `~/.cobra-commander/config.json` | Behaviour settings. Never API keys |
| `~/.cobra-commander/api-token` | The local API bearer token |
| `~/.cobra-commander/projects.json` | Your registered project list |
| `<install>/.env` | Your configuration, including the API key |
| `<install>/.worker-store/` | Per-worker event logs (JSONL), for debugging |
| `<install>/tasks/` | Task queue records and reports |
| `<install>/.intake-requests/` | Intake requirements documents |
| `$TMPDIR/cc-tool-output/` | Truncated tool output, reaped hourly, deleted after 24h |

All of it is local and yours to delete. Worker event logs and task reports can quote source code and
command output, so treat them as you would any build log.

## If you add telemetry downstream

This project is GPL-3.0-or-later. You are free to fork it and add reporting, but if you distribute that
fork, say so plainly in your own documentation — do not inherit this page's claim.
