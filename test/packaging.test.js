'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const packageJson = require('../package.json');

test('require() works, which is what a legacy CommonJS application needs', function () {
  const module = require('../index.js');
  assert.strictEqual(typeof module.Synapsys, 'function');
  assert.strictEqual(typeof module.SynapsysConfigError, 'function');
  assert.strictEqual(typeof module.StopRequested, 'function');
});

test('import works, and resolves to the same module instance as require', async function () {
  const esm = await import(pathToFileURL(path.join(__dirname, '..', 'index.mjs')).href);
  const cjs = require('../index.js');

  assert.strictEqual(typeof esm.Synapsys, 'function');
  // The ESM entry re-exports the CommonJS one rather than duplicating it, so
  // there is a single copy of the state: one set of patched streams, one
  // heartbeat, no dual-package hazard.
  assert.strictEqual(esm.Synapsys, cjs.Synapsys);
  assert.strictEqual(esm.default, cjs);
});

test('every file the exports map points at is published and present', function () {
  const root = path.join(__dirname, '..');
  const entries = ['./index.js', './index.mjs', './index.d.ts'];
  for (const entry of entries) {
    assert.ok(fs.existsSync(path.join(root, entry)), entry + ' is missing');
  }

  // Anything required at runtime has to be inside `files`, or the published
  // tarball installs a package that cannot load.
  assert.ok(packageJson.files.indexOf('lib/') !== -1);
  for (const entry of entries) {
    const bare = entry.replace('./', '');
    assert.ok(packageJson.files.indexOf(bare) !== -1, bare + ' is not in files');
  }
});

test('the published README carries no release or infrastructure detail', function () {
  // npm renders README.md on the public package page, unlike Maven Central. Release
  // process, the publishing workflow and the trusted-publisher configuration name
  // exactly what a supply-chain attack would target, and no consumer of the package
  // needs any of it. It lives in RELEASING.md, which `files` excludes.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const forbidden = [
    'Releasing (maintainers)',
    'Trusted publishing',
    'trusted publisher',
    'npm stage approve',
    'npm stage publish',
    'release.yml',
    'Repository secrets',
    'First-time setup'
  ];
  const found = forbidden.filter(function (needle) {
    return readme.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
  });
  assert.deepStrictEqual(
    found, [],
    'README.md is published publicly on npm and must not contain: ' + found.join(', ')
  );
});

test('RELEASING.md exists and is excluded from the published package', function () {
  const root = path.join(__dirname, '..');
  assert.ok(
    fs.existsSync(path.join(root, 'RELEASING.md')),
    'the maintainer guide should exist in the repository'
  );
  // `files` is an allowlist, so absence is what keeps it out of the tarball.
  assert.strictEqual(
    packageJson.files.indexOf('RELEASING.md'), -1,
    'RELEASING.md must never be added to files'
  );
});

test('the package declares no dependencies', function () {
  // Every transitive dependency is a potential conflict in someone else's build,
  // and a conflict at that layer is a reason not to adopt.
  assert.deepStrictEqual(packageJson.dependencies, {});
  assert.deepStrictEqual(packageJson.devDependencies, {});
});

test('scoped packages are published publicly, not restricted', function () {
  assert.strictEqual(packageJson.publishConfig.access, 'public');
});

test('the minimum Node version is declared and conservative', function () {
  assert.strictEqual(packageJson.engines.node, '>=16.0.0');
});

test('the library loads on the declared minimum without optional-chaining syntax errors', function () {
  // A parse of every shipped file, which is what a Node 16 runtime would do on
  // require. Syntax newer than the declared engine would fail here.
  const libDir = path.join(__dirname, '..', 'lib');
  for (const file of fs.readdirSync(libDir)) {
    if (!/\.js$/.test(file)) continue;
    assert.doesNotThrow(
      function () { require(path.join(libDir, file)); },
      file + ' failed to load'
    );
  }
});
