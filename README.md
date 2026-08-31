# Synapsys Node.js SDK

Register a Node.js application as a Synapsys worker, and let Synapsys Core start and
stop its background processes remotely.

Your application declares processes by handing the SDK a function. It reports them to
Core on a heartbeat, receives start/stop commands on the response, and runs them.
Workers never accept inbound connections — everything rides one outbound POST.

## Compatibility

| | |
| --- | --- |
| Runtime | Node.js 16 or later (tested on 16, 18, 20, 22, 24) |
| Module systems | CommonJS and ESM, both shipped; no build step for either |
| Runtime dependencies | none |
| Framework identifier sent to Core | `nodejs` |
| Core | any version serving `GET /api/health` and `POST /api/v1/workers/heartbeat` |

You also need a reachable Synapsys Core instance and a worker token.

This SDK implements the shared Synapsys client-library specification, which every
official client library follows so that they behave like one product rather than
several interpretations of it:

- `synapsys-docs/CLIENT_LIBRARY_SPEC.md` — the normative client contract
- `synapsys-docs/content/manuals/raw-api/checklist.md` — the wire-protocol checklist
- `openapi.yaml` in the Core repository — the machine-readable contract

## Install

```bash
npm install @synapsys-io/sdk
```

## Quick start

CommonJS — the only file that changes is your entry point:

```js
const { Synapsys } = require('@synapsys-io/sdk');
const { pollInvoices } = require('./jobs/invoice-poller');
const { buildMonthlyReport } = require('./reports');

const synapsys = new Synapsys({
  workerName: 'billing-api',
  heartbeatInterval: '5s'      // coreUrl and coreToken come from the environment
});

synapsys.endless('invoice-poller', async function (stop) {
  while (!stop.requested) {
    await pollInvoices();
    await stop.sleep('30s');
  }
});

synapsys.progressive('monthly-report', buildMonthlyReport);

synapsys.start();
```

ESM is the same, with `import`:

```js
import { Synapsys } from '@synapsys-io/sdk';
```

Set the connection details in the environment:

```bash
SYNAPSYS_CORE_URL=https://core.example.com
SYNAPSYS_CORE_TOKEN=syn_...
```

The token is sent as `Authorization: Bearer <token>`. Keep it in an environment
variable or a secret, never in committed configuration.

## Defining a process

There are exactly two kinds, mirroring the protocol. What runs inside one is your
code; the SDK only decides when it starts and tells it when to stop.

### Endless — runs until stopped

```js
synapsys.endless('invoice-poller', async (stop) => {
  while (!stop.requested) {
    await pollInvoices();
    await stop.sleep('30s');
  }
});
```

The contract is that the body polls `stop.requested` and returns promptly once it is
set. **Use `stop.sleep()` rather than a bare timer**: it resolves the instant a stop
arrives, where a plain `setTimeout` would leave the process sitting in `stopping` for
the full delay and read as a hung worker in the Core console.

### Progressive — runs to completion

```js
synapsys.progressive('monthly-report', async (ctx) => {
  for (const account of accounts) {
    ctx.throwIfCancelled();      // honours a stop command
    await processAccount(account);
  }
});
```

Reaching the end returns the process to `idle` on its own.

### Passing existing functions

Any function reference works — a named declaration, an arrow, a method, or something
imported from a file that has never heard of Synapsys:

```js
const { buildMonthlyReport } = require('./reports');

synapsys.progressive('monthly-report', buildMonthlyReport);
synapsys.progressive(buildMonthlyReport);           // name taken from the function
```

There is no file globbing and no directory convention, deliberately: both break under
esbuild, webpack and ncc, which is what production deployments actually run.

### Cleanup

Both types accept an optional `onStop` hook. It runs after a stop, and a failure in it
is logged without aborting the stop:

```js
synapsys.endless('consumer', run, { onStop: () => connection.close() });
```

## The stop signal

The same object is handed to both process types.

| Member | Meaning |
| --- | --- |
| `stop.requested` | `true` once Core has commanded a stop. The cooperative poll. |
| `stop.signal` | The underlying `AbortSignal`. |
| `stop.sleep(duration)` | Waits, returning early on a stop. Resolves `true` if the full duration elapsed, `false` if it was cut short. |
| `stop.throwIfCancelled()` | Throws if a stop has been requested. Also spelled `throwIfStopped()`. |
| `stop.isStopRequested()` | Alias for `stop.requested`. |

`stop.signal` is how in-flight I/O composes. Hand it to anything that accepts an
`AbortSignal` and the request aborts with the stop, instead of holding the process in
`stopping` until it finishes on its own:

```js
synapsys.progressive('sync-orders', async (ctx) => {
  const response = await fetch(url, { signal: ctx.signal });
  ctx.throwIfCancelled();
  await save(await response.json());
});
```

`stop.sleep()` resolves rather than rejects on a stop, so the canonical loop needs no
`try`/`catch`; the `while` condition ends the run on its next pass. An `AbortError`
raised by aborted I/O is recognised as a stop, not a failure — but only while a stop
is actually outstanding, so an unrelated request timeout still lands the process in
`failed` where it belongs.

## What isolation means on an event loop

The Spring starter gives each progressive process its own thread. Node is
single-threaded, so the guarantee is not identical and it would be dishonest to imply
it is.

**Guaranteed.** Command handling is isolated per process: one process throwing in its
start or stop handler never prevents another receiving a command on the same beat, and
never kills the heartbeat loop. A process that fails never changes another's state. A
rejected promise from your code never propagates into the library, and never reaches
your console as a bare stack trace.

**Not guaranteed.** A process that blocks the event loop synchronously — a tight
`while (true)`, a large synchronous `JSON.parse`, a blocking crypto call — delays
everything on that loop, the heartbeat included. Node offers no preemption, so nothing
can interrupt it. Move CPU-bound work into `worker_threads` or a child process and
drive it from the process body.

For the same reason, cancellation is cooperative. A body that never checks
`stop.requested`, never calls `throwIfCancelled()` and never awaits `stop.sleep()`
cannot be stopped.

## Console capture

Anything a process prints to stdout or stderr while running is streamed to Core and
shown against that run. Your own console is unaffected: every line still reaches the
real stream, in order — it is a tee, never a redirect.

Output is attributed using `AsyncLocalStorage`, so it follows your code across `await`
and into callbacks, and two concurrent processes never have their lines mixed up.
Output from application code that is not running a process is not captured.

Note that **this transmits process output to Core**, including anything you print.
Turn it off with `captureConsole: false`, which leaves `process.stdout.write`
completely untouched.

### Limits you should know about

Console capture works by replacing `process.stdout.write` and `process.stderr.write`
with tees. That is a **process-wide** change, and it comes with boundaries worth
stating plainly:

- **One capture at a time.** The first `Synapsys` instance to start owns the streams;
  a second instance in the same process does not patch them again.
- **Only what goes through those methods is captured.** A logger writing to a file
  descriptor directly, or to its own destination stream, bypasses the tee.
- **Something patched on top of us is never clobbered.** On shutdown the original
  methods are restored only if they are still the ones we installed; otherwise they
  are left alone, and the wrapper keeps working.
- **Bounded, and drops oldest.** At most 10,000 queued lines, 16,000 characters per
  line, and 100 entries or 96 KB of UTF-8 per heartbeat. A runaway loop loses its
  oldest lines rather than the application's memory.
- **The SDK's own log lines are never captured.** They are written through pristine
  handles taken before the patch, so the library cannot feed its own output back to
  Core or recurse through its own tee.
- **Blank lines and lines with no run id are dropped**, because Core cannot store
  them.
- **Nothing is captured when `captureConsole` or `enabled` is `false`**, and nothing
  after `stop()` has restored the streams.

## Settings

Every setting can be passed in the options object or set in the environment. The
options object wins.

| Option | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `SYNAPSYS_ENABLED` | `true` | `false` is a complete no-op: no timer, no network call, no stream interception. |
| `coreUrl` | `SYNAPSYS_CORE_URL` | — | **Required.** Base URL of Synapsys Core. |
| `coreToken` | `SYNAPSYS_CORE_TOKEN` | — | Bearer token for this worker. Core rejects heartbeats without it. |
| `workerName` | `SYNAPSYS_WORKER_NAME` | — | **Required.** This worker's identity across restarts. |
| `host` | `SYNAPSYS_HOST` | machine hostname | Host reported to Core. Set it when the resolved name is meaningless, as with a container id. |
| `heartbeatInterval` | `SYNAPSYS_HEARTBEAT_INTERVAL` | `'5s'` | Interval between heartbeats. Must be a positive whole number of seconds. |
| `failFast` | `SYNAPSYS_FAIL_FAST` | `false` | Reject `start()` when Core is unreachable at startup. |
| `connectTimeout` | `SYNAPSYS_CONNECT_TIMEOUT` | `'2s'` | TCP connect timeout. |
| `requestTimeout` | `SYNAPSYS_REQUEST_TIMEOUT` | `'5s'` | Whole-request timeout. |
| `shutdownTimeout` | `SYNAPSYS_SHUTDOWN_TIMEOUT` | `'10s'` | How long `stop()` waits for running processes to become terminal. |
| `captureConsole` | `SYNAPSYS_CAPTURE_CONSOLE` | `true` | Stream process console output to Core. |
| `logLevel` | `SYNAPSYS_LOG_LEVEL` | `'info'` | One of `debug`, `info`, `warn`, `error`, `silent`. |
| `logger` | — | built-in | Send the SDK's own log lines to your logger. |

### Durations carry units

Write `'30s'`, `'5m'`, `'250ms'` or `'2h'`. A plain number is accepted as
milliseconds, but a unitless string is refused, because `'30'` reads as seconds to
about half the people who write it.

### Unknown options throw

A mistyped key fails immediately rather than silently leaving a default in place:

```
[Synapsys] Unknown Synapsys options: 'heratBeatinterval'. Expected any of: 'enabled',
'coreUrl', 'coreToken', 'workerName', ...
```

This check runs even when `enabled` is `false` — a disabled test run is exactly where
such a typo would otherwise hide.

## Logging

The SDK logs through your own logger when you give it one. Anything with `debug`,
`info`, `warn` and `error` methods works as-is:

```js
const pino = require('pino')();
const synapsys = new Synapsys({ workerName: 'billing-api', logger: pino });
```

Without one, it writes prefixed lines to the console. Every line the library emits,
exception messages included, starts with `[Synapsys] `, so you can grep it out of your
logs. A healthy worker is silent between startup and shutdown: nothing is logged at
`info` on a per-heartbeat cadence.

## Shutdown

`await synapsys.stop()` runs a bounded cooperative shutdown, in this order:

1. the heartbeat loop stops, and no further beat can start;
2. every running process is asked to stop, and its `AbortSignal` is aborted;
3. the SDK waits up to `shutdownTimeout` for them to become terminal;
4. **one** best-effort final heartbeat is sent, carrying the final process states
   and whatever log lines are still queued;
5. the console streams are restored and the sockets are released.

The final heartbeat's response is **ignored**: shutdown never starts new work, even
if Core has a start command outstanding. If it fails, times out, or the budget is
already exhausted, that is logged at `debug` and shutdown continues — a transport
problem never fails or extends your application's shutdown.

Pass a different budget for one call with `stop({ timeout: '30s' })`. The final
heartbeat is additionally bounded by `requestTimeout`, and by whatever is left of
the budget, whichever is smaller.

`stop()` is **idempotent and never throws**. Concurrent callers share one shutdown,
and exactly one final heartbeat is sent however many times you call it.

**Business logic that ignores cancellation is never killed.** Node cannot safely
pull a running function out from under itself, so a body that does not observe its
stop signal stays alive past the budget. The SDK logs a warning naming the process,
keeps observing it, and refuses to start a replacement execution over the top of it.
The decision to wait longer or exit is your application's.

Wire it to your own signal handling — the SDK does not install handlers of its own,
because that would change how your application behaves:

```js
process.on('SIGTERM', async () => {
  await synapsys.stop();
  server.close();
});
```

The heartbeat timer keeps the event loop alive, which is what you want in a worker.
In a short-lived script it means the process will not exit until `stop()` is called.

## Lifecycle semantics

Core owns the desired state; this SDK owns the transition. Every command carries a
token, and the token is acknowledged **only after** the local handler has accepted
it, so anything unacknowledged is redelivered on a later beat.

| Situation | What happens |
| --- | --- |
| `desiredState: 'idle'` | No outstanding command. Never a stop. |
| A start for a process already running | Idempotent no-op, acknowledged. The active `runId` is not reassigned. |
| A stop for a process that is not running | Idempotent no-op, acknowledged. |
| **A start while the previous run is still stopping** | **Deferred.** Not acknowledged, and the old run's `runId` is kept. Core redelivers it; it is applied once the old run is terminal. |
| A command handler that throws | Logged, the process is marked `failed`, the token stays unacknowledged, and the other processes on that beat are unaffected. |
| A duplicate or stale token | Ignored. |

Deferring a start is the difference between a run that happens a few seconds late
and a run that never happens at all: acknowledging it as a no-op would tell Core the
command was carried out when nothing ran.

`running` is set **synchronously**, before the body is scheduled, so a second start
arriving in the same tick cannot observe `idle` and spawn a duplicate.

## Cancellation

A stop aborts the run's `AbortSignal` and sets `stop.requested`. Returning from the
body — or throwing that run's `StopRequested`, or an `AbortError` raised by I/O you
handed the signal to — is a **clean stop, not a failure**: the process goes back to
`idle` and nothing is logged as an error. An `AbortError` arriving while no stop is
outstanding is a genuine failure and lands the process in `failed`.

## Failure behaviour

- **Core being unreachable never stops a process.** The worker keeps running and keeps
  retrying, and converges on the next successful beat.
- **Startup does not block on Core.** A worker that starts while Core is down is the
  normal case, not an error. Set `failFast: true` and `await synapsys.start()` if you
  want the opposite.
- **The heartbeat loop cannot die.** Nothing escapes a tick.
- **Heartbeats never overlap and never burst.** The next beat is scheduled after the
  previous one settles, so a Core that answers slower than one interval delays the
  loop rather than queueing a catch-up storm against a service that has just
  recovered.
- **A 2xx response that is not a readable heartbeat response is a failure.** An empty
  or unparseable body means the beat delivered no commands, so the drained log lines
  are requeued at the front of the queue and nothing is acknowledged. Unknown *fields*
  are still ignored: Core is versioned independently of this SDK.
- **Your exceptions never reach the library.** A process whose body throws is recorded
  as `failed`, the stack trace is sent to Core as process output, and the error is
  logged — never rethrown into your application.

## Removing it

Delete the registration lines and the `new Synapsys(...)` call and the application
works as it did before. Nothing else in your code refers to the SDK.

## Testing your application

Set `enabled: false`, or `SYNAPSYS_ENABLED=false`, and the SDK does nothing at all:
no timer, no network call, and `process.stdout.write` is left exactly as it was. It
does not even require `coreUrl` or `workerName` in that state.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright 2026 Julian Marzoli (Basamento).
