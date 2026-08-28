# Releasing @synapsys-io/sdk

**Internal. Not published to npm.**

This file is deliberately absent from `files` in `package.json`, so it is never
included in the tarball and never rendered on the public package page. It names the
repository, the workflow that publishes, and the trusted-publisher configuration —
all of which tell an attacker exactly what to target in a supply-chain attempt, and
none of which a consumer of the package needs.

Keep release and infrastructure detail here, not in `README.md`. npm publishes the
README publicly; Maven Central does not, which is why the Spring starter can carry
its release guide inline and this repository cannot.

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

Approving needs **npm 11.15.0 or later** on your machine, which in turn needs
**Node 20.17 or later** (`^20.17.0 || >=22.9.0`). This is the maintainer's toolchain,
unrelated to the Node 16 the package itself supports:

```bash
npm install -g npm@^11.15.0
```

Do not use `npm@latest` here. npm 12 requires Node `^22.22 || ^24.15 || >=26`, so on
an older Node it fails to install rather than falling back — the same trap the release
workflow pins around.

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
