# Local Scheduler MCP

A minimal, zero-config MCP (Model Context Protocol) server that runs recurring automations and one-shot background tasks on your local machine. It supports shell commands and inline code (JavaScript, Python, PowerShell).

## What it does

- **Recurring automations**: Executes tasks on a schedule defined in minutes (`intervalMinutes`)
- **One-shot tasks**: Run long background tasks via `run_task`, get a `taskId` immediately, check status later with `get_task_status`
- **Built-in security validator**: Blocks dangerous commands, scripts, and working directories before execution
- Stores automation state, task state, logs, and notifications locally in `~/.codex/local-scheduler/`
- Exposes standard MCP tools so any MCP-compatible agent can create, list, and inspect automations and tasks
- Optionally pushes results to a webhook URL
- Sends MCP logging messages when tasks complete (for clients that listen)

## Architecture

```
Agent (Claude, GPT, Codex, etc.)
  |
  | MCP stdio protocol
  v
local-scheduler MCP server (Node.js)
  |
  |-- setInterval(30s) checks nextRun for automations
  |-- run_task executes immediately in background
  v
Logs + Notifications + Tasks persisted to disk
```

## Files

| File | Purpose |
|------|---------|
| `server.js` | MCP server entry point |
| `lib.js` | Shared state, persistence, scheduler logic, security validator |
| `package.json` | Dependencies (`@modelcontextprotocol/sdk`, `zod`) |
| `~/.codex/local-scheduler/automations.json` | Active automation definitions |
| `~/.codex/local-scheduler/tasks.json` | One-shot task definitions and results |
| `~/.codex/local-scheduler/notifications.jsonl` | One JSON line per run |
| `~/.codex/local-scheduler/scripts/` | Inline scripts stored on disk |
| `~/.codex/local-scheduler/config.json` | Webhook URL and settings |

## Tools

### Recurring Automations

#### `create_automation`

Create a recurring task. Provide **either** `command` **or** `script`.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | yes | Human-readable name |
| `intervalMinutes` | `number` | yes | How often to run |
| `cwd` | `string` | no | Working directory |
| `command` | `string` | no | Shell command |
| `script` | `string` | no | Inline code |
| `scriptType` | `"javascript" | "python" | "powershell"` | no | Language (default: `javascript`) |
| `model` | `string` | no | Model hint |
| `reasoningEffort` | `string` | no | Reasoning effort hint |

#### `list_automations`

Returns all active automations with their next scheduled run time.

#### `delete_automation`

Delete by `id`. Also removes the persisted inline script file if one exists.

#### `get_automation_logs`

Get execution history for a specific automation.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | Automation ID |
| `limit` | `number` | no | Max entries to return |

### One-Shot Tasks

#### `run_task`

Run a background task immediately and return a `taskId`. The task executes asynchronously. Check status later with `get_task_status`.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | `string` | yes | Task name |
| `cwd` | `string` | no | Working directory |
| `command` | `string` | no | Shell command |
| `script` | `string` | no | Inline code |
| `scriptType` | `"javascript" | "python" | "powershell"` | no | Language (default: `javascript`) |
| `timeoutMs` | `number` | no | Timeout in ms (default: `300000` = 5 min) |

**Returns:** `Task <id> started. Use get_task_status with id=<id> to check progress.`

#### `get_task_status`

Get the current status and full output of a one-shot task.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | Task ID |

**Status values:** `running`, `completed`, `failed`

#### `list_tasks`

List all one-shot tasks ordered by most recent.

#### `delete_task`

Delete a one-shot task and its script file.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | Task ID |

### Notifications

#### `check_notifications`

Read the notification queue. Each automation run or task completion appends a JSON line to `notifications.jsonl`.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `since` | `string` | no | ISO timestamp filter |
| `limit` | `number` | no | Max entries |

#### `ack_notifications`

Acknowledge notifications up to a given timestamp.

#### `get_pending_summary`

Get a one-line summary of pending notifications for quick status checks.

#### `set_webhook`

Configure a URL to receive `POST` requests on every automation or task run.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | `string` | yes | Webhook endpoint |

## Security (v3.0.0)

The MCP includes a built-in security validator that blocks dangerous commands, scripts, and working directories before execution.

### What is blocked

| Category | Examples |
|---|---|
| Shell destructive | `rm -rf /`, `format`, `diskpart`, `mkfs`, `del /f /s /q` |
| Pipe to shell | `curl ... | sh`, `wget ... | bash` |
| PowerShell destructive | `Remove-Item -Recurse -Force C:`, `Format-Volume`, `Clear-Disk` |
| Node.js destructive | `fs.rmSync('/', {recursive:true})`, `fs.rmdirSync` |
| Python destructive | `os.system('rm -rf /')`, `shutil.rmtree`, `subprocess.call(['rm',...])` |
| Forbidden directories | `C:\\Windows`, `C:\\Program Files`, `C:\\Users` (other than current user), root `/` |

### What is allowed

- User home directory and subdirectories (Documents, Desktop, .codex)
- Known development roots: `D:\\repos`, `C:\\temp`, `C:\\tmp`

The validator runs automatically on every `create_automation` and `run_task` call. If a request is blocked, the tool returns `isError: true` with a descriptive message.

## How the LLM knows a task finished

LLMs are ephemeral: they only exist during a conversation turn. They cannot automatically "know" something that happens while they are not running. Three mechanisms are available:

1. **Polling** — the agent calls `get_task_status` or `check_notifications` when the user interacts.
2. **Webhook** — configure `set_webhook` to an endpoint the agent listens to; the MCP POSTs there when tasks complete.
3. **MCP logging messages** — the server sends `notifications/message` to the client when a task or automation completes. If the client displays or acts on log messages, the agent sees them.

Fully automatic "wake up the LLM" push requires client-side support that most MCP clients do not yet expose.

## Registering in Codex Desktop

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.local-scheduler]
command = "node"
args = ['C:\\Users\\Administrador\\local-scheduler-mcp\\server.js']
```

> **Important:** Use single backslashes in `args`, not double. Double backslashes (`\\`) are interpreted literally in TOML single-quoted strings and will create an invalid path.

Restart Codex Desktop after editing.

## Scheduler behavior

- Tick interval: **30 seconds**
- Evaluates `nextRun` against `Date.now()`
- When a run fires, `nextRun` is recalculated as `now + intervalMinutes * 60 * 1000`
- Automation command timeout: **120 seconds**
- Task default timeout: **300 seconds**
- Max log history per automation: **100 entries**

## Inline script execution

When `script` is provided, the server:

1. Writes the code to `~/.codex/local-scheduler/scripts/<id>.<ext>`
2. Executes it with the appropriate runner:
   - `.js` -> `node`
   - `.py` -> `python`
   - `.ps1` -> `powershell -ExecutionPolicy Bypass -File`

## Tests

Run the built-in test suite (no extra dependencies required, uses Node.js built-in `node:test`):

```bash
npm test
```

### Test coverage

| Suite | File | What it tests |
|---|---|---|
| **Unit** | `test/unit.test.js` | State persistence, notifications, `resolveCommand`, `resetState`, security validator |
| **Scheduler** | `test/scheduler.test.js` | Tick firing logic, log capping, inline script writing |
| **Integration** | `test/integration.test.js` | Full MCP stdio protocol: initialize, list tools, create automation, run task, poll status, delete, security rejection |

All tests use temporary directories so they do not interfere with your live `~/.codex/local-scheduler/` data.

## License

MIT
