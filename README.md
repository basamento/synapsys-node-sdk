# Synapsys Node.js SDK

Register a Node.js application as a Synapsys worker, and let Synapsys Core start and
stop its background processes remotely.

Your application declares processes by handing the SDK a function. It reports them to
Core on a heartbeat, receives start/stop commands on the response, and runs them.
Workers never accept inbound connections — everything rides one outbound POST.

## Requirements

- Node.js 16 or later
- CommonJS or ESM; both are shipped, and no build step is needed for either
- A reachable Synapsys Core instance and a worker token

Zero runtime dependencies.

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

`synapsys.stop()` stops the loop, restores the console streams and asks every running
process to stop. It is idempotent and never throws.

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

## Failure behaviour

- **Core being unreachable never stops a process.** The worker keeps running and keeps
  retrying, and converges on the next successful beat.
- **Startup does not block on Core.** A worker that starts while Core is down is the
  normal case, not an error. Set `failFast: true` and `await synapsys.start()` if you
  want the opposite.
- **The heartbeat loop cannot die.** Nothing escapes a tick.
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

---

# Releasing (maintainers)

## Coordinates

| | |
| --- | --- |
| npm package | `@synapsys-io/sdk` |
| npm scope | `@synapsys-io` |
| Repository | `basamento/synapsys-node-sdk` |
| Registry | npmjs.com, public (`publishConfig.access: public`) |

The scope is `@synapsys-io` because `basamento` and `synapsys` were both taken as
npm organisation names. It is the one place the umbrella naming breaks; npm is
product-scoped.

## First-time setup

npm's trusted publishing (OIDC) removes the need for an `NPM_TOKEN` secret, but it
**can only be configured for a package that already exists**. The first version has to
be published by hand, once:

```bash
npm login
npm publish
```

Then, on npmjs.com, under the package's **Settings → Trusted publishing**, add a
publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization | `basamento` |
| Repository | `synapsys-node-sdk` |
| Workflow | `release.yml` |
| Allowed actions | select **both** `npm publish` and `npm stage publish` |

Configurations created after 20 May 2026 require at least one allowed action to be
selected explicitly. `npm stage publish` is the one this workflow uses; including
`npm publish` as well leaves the direct route available if staging is ever dropped.

After that, no secret is stored in the repository and every release runs from CI.

## Releasing a version

### 1. Bump the version

Edit `version` in `package.json`, commit, and get it onto `main`.

### 2. Tag and push

```bash
git checkout main && git pull
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

The `Release` workflow checks that the tagged commit is reachable from `main` and that
the tag matches `package.json`, runs the suite on the oldest and newest supported Node
versions, then stages the package. Both guards run before anything is uploaded.

### 3. Approve

The upload is staged, not live:

```bash
npm stage list
npm stage view <stage-id>      # inspect the tarball that would go out
npm stage approve <stage-id>   # prompts for 2FA, then publishes
```

`npm stage reject <stage-id>` discards it instead. A rejected version number can be
reused.

> **Publishing is effectively irreversible.** npm's unpublish window is 72 hours and
> restricted after that. The approval step exists because there is no undo.

### If a check fails

`Tag does not match package.json version` — the version was not bumped, or the tag was
mistyped. Delete the tag, fix, and tag again:

```bash
git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0
```

`Tagged commit is not reachable from main` — the tag was cut from a branch. Merge to
`main` first.

## Provenance

npm can generate a signed provenance attestation tying a tarball to the commit and
workflow that built it, but **only for a public repository**. This repository is
private, so `--provenance` is not requested; staged publishing carries the
supply-chain story instead. If the repository is ever made public, add `--provenance`
to the stage step and the attestation appears on the package page.

## Checking what will ship

```bash
npm pack --dry-run
```

The tarball should contain `index.js`, `index.mjs`, `index.d.ts`, `lib/`, and nothing
else beyond the licence and readme. CI installs the packed tarball into a clean
CommonJS and a clean ESM application on every run, because a file missing from `files`
breaks the published package while every local test still passes.
