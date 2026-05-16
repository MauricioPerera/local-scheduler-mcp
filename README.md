# local-scheduler-mcp

MCP stdio server for local automation scheduling. Recurring automations, one-shot background tasks, built-in templates, and pending notifications.

## Version

3.1.1

## Install

```bash
git clone https://github.com/MauricioPerera/local-scheduler-mcp.git
cd local-scheduler-mcp
npm install
```

## Run

```bash
node server.js
```

Data directory: `~/.codex/local-scheduler/` (or `$CODEX_HOME/local-scheduler` if set, or `SCHEDULER_TEST_DIR` during tests).

## Tools (14)

### Automation management

| Tool | Description |
|---|---|
| `create_automation` | Create a recurring automation with command or inline script |
| `list_automations` | List all automations with last log and next run time |
| `delete_automation` | Remove an automation and its script file |
| `get_automation_logs` | Get recent run logs for an automation |

### Templates (v3.1.0+)

| Tool | Description |
|---|---|
| `list_templates` | List available templates with metadata |
| `instantiate_template` | Create an automation from a pre-defined template |

Built-in templates:

| ID | Default Command | Interval | Use |
|---|---|---|---|
| `build-project` | `dotnet build` | 60 min | Build .NET projects |
| `disk-check` | `Get-PSDrive C | Select-Object Used,Free` | 5 min | Monitor disk space |
| `git-sync` | `git pull` | 30 min | Keep repo synced |

Templates support `${key}` interpolation. Pass `params` as JSON string:
```json
{"repoPath": "D:/repos/my-project"}
```

Templates can define `requiredParams`. Missing required values return an error before execution.

### Task management

| Tool | Description |
|---|---|
| `run_task` | Run a one-shot background task and return a taskId |
| `get_task_status` | Check the status and output of a one-shot task |
| `list_tasks` | List all one-shot tasks |
| `delete_task` | Remove a one-shot task and its script file |

### Notifications

| Tool | Description |
|---|---|
| `check_notifications` | Check pending notifications since last ack |
| `ack_notifications` | Mark all notifications up to a timestamp as read |
| `get_pending_summary` | Summary of pending notifications grouped by automation |
| `set_webhook` | Set a webhook URL for notifications |

## Security

Five layers:

1. **Command blocklist**: `rm -rf /`, `format`, `curl | sh`, etc.
2. **Script blocklist**: Dangerous JS/Python/PowerShell patterns.
3. **CWD allowlist**: User home, `~/.codex`, `C:/temp`, `C:/tmp`, and any directories set in `SCHEDULER_ALLOWED_DIRS` env var (semicolon-separated).
4. **Template interpolation hardening** (v3.1.1+): Interpolated values must match `^[a-zA-Z0-9_\-/: .~]+$`. Shell metacharacters (`;`, `|`, `&`, `$`, quotes, etc.) are rejected.
5. **Required params** (v3.1.1+): Templates can declare `requiredParams`. Missing values produce a clear error instead of sending `${key}` literal to the shell.

## Environment Variables

| Variable | Purpose |
|---|---|
| `SCHEDULER_TEST_DIR` | Override data directory for tests |
| `SCHEDULER_ALLOWED_DIRS` | Semicolon-separated list of additional allowed working directories |
| `SCHEDULER_WEBHOOK_URL` | Default webhook URL for notifications |
| `CODEX_HOME` | Base directory for `~/.codex` fallback |

## Persistence

| File | Content |
|---|---|
| `automations.json` | Recurring automations (Map O(1), atomic writes) |
| `tasks.json` | One-shot tasks (Map O(1), atomic writes) |
| `notifications.jsonl` | Append-only log; rotates at >512 KB keeping last 250 lines |
| `config.json` | Webhook URL and settings |
| `templates.json` | Custom template overrides (optional) |

## Tests

```bash
npm test
```

54 tests, 0 failures.

## Changelog

### v3.1.1
- Secure template interpolation: blocks shell metacharacters in `${key}` values
- Required params validation in templates
- JSON.parse error handling in `instantiate_template`
- 3 new unit tests + 2 integration tests (54 total)

### v3.1.0
- Automation templates system (built-in + custom via `templates.json`)
- `list_templates` and `instantiate_template` tools
- Map O(1) lookups, atomic writes, tail-based notification read, rotation

### v3.0.0
- Initial release: automations, tasks, notifications, security validator

## License

MIT
