
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const TEST_DIR = path.join(os.tmpdir(), 'local-scheduler-int-test-' + Date.now().toString(36));

function cleanTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function sendJsonRpc(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

async function readResponse(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
    let buf = '';
    const handler = (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim().replace(/\r$/, '');
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            proc.stdout.off('data', handler);
            clearTimeout(timer);
            resolve(msg);
            return;
          }
        } catch {}
      }
      buf = lines[lines.length - 1];
    };
    proc.stdout.on('data', handler);
  });
}

describe('integration: MCP stdio protocol', () => {
  let proc;

  before(async () => {
    cleanTestDir();
    process.env.SCHEDULER_TEST_DIR = TEST_DIR;
    proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, SCHEDULER_TEST_DIR: TEST_DIR },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 3000);
      proc.stderr.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  after(() => {
    if (proc && !proc.killed) {
      proc.kill();
    }
    cleanTestDir();
  });

  it('initializes MCP connection', async () => {
    sendJsonRpc(proc, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
    const res = await readResponse(proc);
    assert.strictEqual(res.id, 1);
    assert.ok(res.result && res.result.protocolVersion);
  });

  it('lists tools', async () => {
    sendJsonRpc(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const res = await readResponse(proc);
    assert.strictEqual(res.id, 2);
    assert.ok(Array.isArray(res.result.tools));
    const names = res.result.tools.map(t => t.name);
    const expected = ['create_automation', 'list_automations', 'delete_automation', 'get_automation_logs',
      'check_notifications', 'ack_notifications', 'set_webhook', 'get_pending_summary',
      'run_task', 'get_task_status', 'list_tasks', 'delete_task'];
    for (const name of expected) {
      assert.ok(names.includes(name), 'Missing tool: ' + name);
    }
  });

  it('creates an automation', async () => {
    sendJsonRpc(proc, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'create_automation', arguments: { name: 'TestBuild', intervalMinutes: 60, command: 'echo hello' } }
    });
    const res = await readResponse(proc);
    assert.strictEqual(res.id, 3);
    assert.ok(res.result.content[0].text.includes('Created automation'));
  });

  it('lists automations including new one', async () => {
    sendJsonRpc(proc, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_automations', arguments: {} } });
    const res = await readResponse(proc);
    assert.strictEqual(res.id, 4);
    assert.ok(res.result.content[0].text.includes('TestBuild'));
  });

  it('runs a one-shot task', async () => {
    sendJsonRpc(proc, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'run_task', arguments: { name: 'QuickTask', command: 'echo task-output' } }
    });
    const res = await readResponse(proc);
    assert.strictEqual(res.id, 5);
    const text = res.result.content[0].text;
    assert.ok(text.includes('Task') && text.includes('started'));
    const idMatch = text.match(/Task ([a-z0-9]+) started/);
    assert.ok(idMatch, 'Task ID not found in response');
    const taskId = idMatch[1];

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      sendJsonRpc(proc, {
        jsonrpc: '2.0', id: 50 + i, method: 'tools/call',
        params: { name: 'get_task_status', arguments: { id: taskId } }
      });
      const statusRes = await readResponse(proc);
      if (statusRes.result.content[0].text.includes('completed') || statusRes.result.content[0].text.includes('failed')) {
        assert.ok(statusRes.result.content[0].text.includes('task-output'));
        break;
      }
    }
  });

  it('get_pending_summary reflects task notification', async () => {
    sendJsonRpc(proc, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_pending_summary', arguments: {} } });
    const res = await readResponse(proc);
    assert.strictEqual(res.id, 6);
    const text = res.result.content[0].text;
    assert.ok(text.includes('pending notifications'));
    assert.ok(text.includes('QuickTask'));
  });

  it('deletes automation', async () => {
    sendJsonRpc(proc, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_automations', arguments: {} } });
    const listRes = await readResponse(proc);
    const text = listRes.result.content[0].text;
    // Find the first automation id in the JSON list
    const match = text.match(/\"id\":\s*\"([a-z0-9]+)\"/);
    assert.ok(match, 'No automation ID found in: ' + text);
    const id = match[1];
    sendJsonRpc(proc, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delete_automation', arguments: { id } } });
    const delRes = await readResponse(proc);
    assert.strictEqual(delRes.id, 8);
    assert.ok(delRes.result.content[0].text.includes("Deleted"));


it('rejects dangerous command via MCP', async () => {
  sendJsonRpc(proc, {
    jsonrpc: '2.0', id: 90, method: 'tools/call',
    params: { name: 'run_task', arguments: { name: 'Evil', command: 'rm -rf /' } }
  });
  const res = await readResponse(proc);
  assert.strictEqual(res.id, 90);
  assert.ok(res.result.content[0].text.includes('Security error'));
  assert.ok(res.result.isError);
});

it('rejects dangerous script via MCP', async () => {
  sendJsonRpc(proc, {
    jsonrpc: '2.0', id: 91, method: 'tools/call',
    params: { name: 'create_automation', arguments: { name: 'Evil', intervalMinutes: 60, script: `fs.rmSync("/", {recursive:true})`, scriptType: 'javascript' } }
  });
  const res = await readResponse(proc);
  assert.strictEqual(res.id, 91);
  assert.ok(res.result.content[0].text.includes('Security error'));
  assert.ok(res.result.isError);
});

it('rejects forbidden cwd via MCP', async () => {
  sendJsonRpc(proc, {
    jsonrpc: '2.0', id: 92, method: 'tools/call',
    params: { name: 'run_task', arguments: { name: 'Evil', cwd: 'C:\\\\Windows', command: 'echo hello' } }
  });
  const res = await readResponse(proc);
  assert.strictEqual(res.id, 92);
  assert.ok(res.result.content[0].text.includes('Security error'));
  assert.ok(res.result.isError);
});
  });
});
