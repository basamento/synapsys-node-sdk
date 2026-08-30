'use strict';

/**
 * How the client treats what comes back on the wire: malformed bodies, failed
 * beats, log requeueing, and the scheduling rule that keeps a slow Core from
 * producing a burst of catch-up heartbeats.
 */

const test = require('node:test');
const assert = require('node:assert');

const { Synapsys } = require('../index.js');
const { FakeCore, waitFor, recordingLogger } = require('./fake-core');

async function withWorker(options, body) {
  const core = new FakeCore();
  await core.listen();
  const logger = recordingLogger();
  const synapsys = new Synapsys(Object.assign({
    coreUrl: core.url,
    coreToken: 'test-token',
    workerName: 'test-worker',
    heartbeatInterval: '1s',
    captureConsole: false,
    logger: logger
  }, options || {}));

  try {
    return await body({ core: core, synapsys: synapsys, logger: logger });
  } finally {
    await synapsys.stop({ timeout: '1s' });
    await core.close();
  }
}

test('the health probe does not carry the bearer token', async function () {
  const core = new FakeCore();
  await core.listen();
  const seen = [];
  const original = core.server.listeners('request')[0];
  core.server.removeAllListeners('request');
  core.server.on('request', function (request, response) {
    if (request.url === '/api/health') seen.push(request.headers.authorization || null);
    original(request, response);
  });

  const synapsys = new Synapsys({
    coreUrl: core.url,
    coreToken: 'test-token',
    workerName: 'w',
    heartbeatInterval: '1s',
    captureConsole: false,
    logger: recordingLogger()
  });
  try {
    await synapsys.start();
    assert.deepStrictEqual(seen, [null], 'health is unauthenticated in Core');
  } finally {
    await synapsys.stop({ timeout: '1s' });
    await core.close();
  }
});

test('a malformed 2xx heartbeat body is a protocol failure, not a success', async function () {
  await withWorker(null, async function (ctx) {
    ctx.core.rawHeartbeatBody = '{"processes": [{"name":';
    ctx.synapsys.endless('p', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });
    await ctx.synapsys.start();

    await waitFor(function () {
      return ctx.logger.has('warn', 'malformed heartbeat response');
    }, 'malformed response reported');
  });
});

test('an empty 2xx heartbeat body is a protocol failure', async function () {
  await withWorker(null, async function (ctx) {
    ctx.core.rawHeartbeatBody = '';
    ctx.synapsys.endless('p', async function () {});
    await ctx.synapsys.start();

    await waitFor(function () {
      return ctx.logger.has('warn', 'malformed heartbeat response');
    }, 'empty response reported');
  });
});

test('a malformed response does not acknowledge commands', async function () {
  await withWorker(null, async function (ctx) {
    ctx.synapsys.endless('p', async function (stop) {
      while (!stop.requested) await stop.sleep('20ms');
    });
    await ctx.synapsys.start();
    await waitFor(function () { return ctx.core.beats.length > 0; }, 'first beat');

    ctx.core.command('p', 'running', 4, 41);
    ctx.core.rawHeartbeatBody = 'not json at all';
    await waitFor(function () {
      return ctx.logger.has('warn', 'malformed heartbeat response');
    }, 'malformed response reported');

    assert.strictEqual(ctx.synapsys.processes[0].ackToken, 0);
    assert.strictEqual(ctx.synapsys.processes[0].currentState, 'idle');

    // Core recovers; the same command is applied on the next beat.
    ctx.core.rawHeartbeatBody = null;
    await waitFor(function () {
      return ctx.synapsys.processes[0].ackToken === 4;
    }, 'command applied after recovery', 6000);
  });
});

test('logs drained for a malformed response are requeued in order', async function () {
  await withWorker({ captureConsole: true }, async function (ctx) {
    ctx.synapsys.progressive('printer', async function () {
      console.log('line one');
      console.log('line two');
      console.log('line three');
    });
    await ctx.synapsys.start();

    // Refuse every beat while the run produces its output.
    ctx.core.rawHeartbeatBody = 'garbage';
    ctx.core.command('printer', 'running', 1, 12345);
    await waitFor(function () {
      return ctx.synapsys.processes[0].currentState === 'idle' &&
        ctx.synapsys.processes[0].ackToken === 0;
    }, 'run finished without acknowledgement', 6000);

    ctx.core.rawHeartbeatBody = null;
    await waitFor(function () {
      return ctx.core.acceptedLogs.length >= 3;
    }, 'logs delivered after recovery', 8000);

    const messages = ctx.core.acceptedLogs.map(function (entry) { return entry.message; });
    assert.deepStrictEqual(messages.slice(0, 3), ['line one', 'line two', 'line three']);
  });
});

test('a slow Core produces no catch-up burst of heartbeats', async function () {
  await withWorker({ heartbeatInterval: '1s', requestTimeout: '5s' }, async function (ctx) {
    ctx.core.responseDelayMs = 1500; // slower than one interval
    ctx.synapsys.endless('p', async function (stop) {
      while (!stop.requested) await stop.sleep('50ms');
    });
    await ctx.synapsys.start();

    await waitFor(function () { return ctx.core.beats.length >= 2; }, 'two slow beats', 8000);
    const afterSlow = ctx.core.beats.length;

    ctx.core.responseDelayMs = 0;
    await new Promise(function (resolve) { setTimeout(resolve, 300); });

    // With a fixed *rate* scheduler, every interval missed while Core was slow
    // would fire at once here. A fixed *delay* scheduler cannot.
    const burst = ctx.core.beats.length - afterSlow;
    assert.ok(burst <= 1, 'expected at most one immediate beat, saw ' + burst);
  });
});

test('heartbeats never overlap', async function () {
  await withWorker({ heartbeatInterval: '1s', requestTimeout: '5s' }, async function (ctx) {
    let concurrent = 0;
    let peak = 0;
    ctx.core.responseDelayMs = 400;
    ctx.core.onBeat = function () {
      concurrent++;
      peak = Math.max(peak, concurrent);
      setTimeout(function () { concurrent--; }, 350);
    };
    ctx.synapsys.endless('p', async function (stop) {
      while (!stop.requested) await stop.sleep('50ms');
    });
    await ctx.synapsys.start();

    await waitFor(function () { return ctx.core.beats.length >= 3; }, 'three beats', 8000);
    assert.strictEqual(peak, 1, 'two heartbeats were in flight at once');
  });
});

test('Core being unavailable never stops a running process', async function () {
  await withWorker(null, async function (ctx) {
    let iterations = 0;
    ctx.synapsys.endless('p', async function (stop) {
      while (!stop.requested) {
        iterations++;
        await stop.sleep('20ms');
      }
    });
    await ctx.synapsys.start();
    ctx.core.command('p', 'running', 1, 5);
    await waitFor(function () {
      return ctx.synapsys.processes[0].currentState === 'running';
    }, 'running');

    ctx.core.heartbeatStatus = 503;
    const before = iterations;
    await new Promise(function (resolve) { setTimeout(resolve, 300); });

    assert.ok(iterations > before, 'the process kept working');
    assert.strictEqual(ctx.synapsys.processes[0].currentState, 'running');
  });
});
