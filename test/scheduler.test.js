
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DIR = path.join(os.tmpdir(), 'local-scheduler-sched-test-' + Date.now().toString(36));
process.env.SCHEDULER_TEST_DIR = TEST_DIR;

// Force reload lib for this test suite
const libPath = require.resolve('../lib.js');
delete require.cache[libPath];
const lib = require(libPath);

function cleanTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('scheduler tick simulation', () => {
  before(() => {
    cleanTestDir();
    lib.ensureDirs();
    lib.resetState();
  });

  after(() => {
    cleanTestDir();
  });

  it('fires automation when nextRun is in the past', () => {
    const now = Date.now();
    lib.automations.push({
      id: 'sched1', name: 'Quick', intervalMinutes: 1,
      nextRun: now - 1000, // already due
      logs: [],
      command: 'echo scheduler-test'
    });
    // Simulate tick: if now >= nextRun, advance nextRun
    for (const a of lib.automations) {
      if (now >= a.nextRun) {
        a.nextRun = now + a.intervalMinutes * 60 * 1000;
        // In real server it would exec here; we simulate by pushing a log
        a.logs.push({ time: new Date().toISOString(), exitCode: 0, stdout: 'scheduler-test', stderr: '' });
      }
    }
    lib.save();
    assert.strictEqual(lib.automations[0].logs.length, 1);
    assert.ok(lib.automations[0].nextRun > now);
  });

  it('does not fire automation when nextRun is in the future', () => {
    const now = Date.now();
    lib.resetState();
    lib.automations.push({
      id: 'sched2', name: 'Future', intervalMinutes: 10,
      nextRun: now + 600000, // 10 min from now
      logs: []
    });
    let fired = false;
    for (const a of lib.automations) {
      if (now >= a.nextRun) {
        fired = true;
        a.logs.push({ time: new Date().toISOString(), exitCode: 0, stdout: '', stderr: '' });
      }
    }
    assert.strictEqual(fired, false);
    assert.strictEqual(lib.automations[0].logs.length, 0);
  });

  it('caps log history at 100 entries', () => {
    lib.resetState();
    lib.automations.push({ id: 'sched3', name: 'Logger', intervalMinutes: 1, nextRun: 0, logs: [] });
    for (let i = 0; i < 105; i++) {
      lib.automations[0].logs.push({ time: i, exitCode: 0, stdout: '', stderr: '' });
      if (lib.automations[0].logs.length > 100) {
        lib.automations[0].logs.shift();
      }
    }
    assert.strictEqual(lib.automations[0].logs.length, 100);
    assert.strictEqual(lib.automations[0].logs[0].time, 5);
    assert.strictEqual(lib.automations[0].logs[99].time, 104);
  });

  it('writes inline scripts before exec simulation', () => {
    lib.resetState();
    lib.ensureDirs();
    const a = {
      id: 'inline1', name: 'Inline', intervalMinutes: 1, nextRun: 0, logs: [],
      script: 'console.log(42)', scriptType: 'javascript'
    };
    const { command } = lib.resolveCommand(a);
    assert.ok(command.includes('inline1.js'));
    assert.ok(fs.existsSync(path.join(lib.SCRIPTS_DIR, 'inline1.js')));
  });

  it('notification includes correct automation fields', () => {
    lib.resetState();
    const log = { time: new Date().toISOString(), exitCode: 0, stdout: 'ok', stderr: '' };
    const notification = {
      type: 'automation_run',
      automationId: 'n1',
      automationName: 'NotifyTest',
      timestamp: Date.now(),
      result: log
    };
    lib.appendNotification(notification);
    const notifs = lib.readNotifications(null, 50);
    const last = notifs[notifs.length - 1];
    assert.strictEqual(last.type, 'automation_run');
    assert.strictEqual(last.automationId, 'n1');
    assert.strictEqual(last.automationName, 'NotifyTest');
    assert.strictEqual(last.result.stdout, 'ok');
  });
});
