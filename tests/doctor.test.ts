/**
 * Preflight diagnostics: worker binary, model resolution, provider auth.
 * No real pi process and no model calls - the catalog is a stand-in and the
 * binary check runs against a temp PATH.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runDiagnostics, formatDiagnostics, type ModelCatalog } from '../extensions/lib/doctor.ts';
import { loadConfig } from '../extensions/lib/config.ts';

const baseConfig = loadConfig();

/** A catalog holding the given models, with auth configured for `authedProviders`. */
function catalog(
  models: Array<{ id: string; provider: string }>,
  authedProviders: string[] = []
): ModelCatalog {
  return {
    getAll: () => models,
    hasConfiguredAuth: (model) => authedProviders.includes(model.provider),
    getProviderDisplayName: (provider) => provider,
  };
}

/** A PATH directory containing an executable named `pi`. */
function pathWithPi(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shunt-path-'));
  const bin = path.join(dir, 'pi');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  return dir;
}

/** A PATH directory with nothing in it. */
function emptyPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shunt-nopath-'));
}

const gemini = { id: 'gemini-2.5-flash', provider: 'google' };
const sonnet = { id: 'claude-sonnet-5', provider: 'anthropic' };

function check(checks: ReturnType<typeof runDiagnostics>, name: string) {
  const found = checks.find((c) => c.name === name);
  assert.ok(found, `expected a check named ${name}, got ${checks.map((c) => c.name).join(', ')}`);
  return found;
}

test('reports every check as ok when the environment is sound', () => {
  const checks = runDiagnostics({
    config: baseConfig,
    catalog: catalog([gemini], ['google']),
    pathValue: pathWithPi(),
  });

  assert.deepEqual(
    checks.filter((c) => c.status !== 'ok'),
    [],
    'no check should fail on a sound setup'
  );
});

test('fails when the pi binary is not on PATH', () => {
  const checks = runDiagnostics({
    config: baseConfig,
    catalog: catalog([gemini], ['google']),
    pathValue: emptyPath(),
  });

  const binary = check(checks, 'worker binary');
  assert.equal(binary.status, 'fail');
  assert.match(binary.detail, /pi/);
  assert.match(binary.detail, /PATH/);
});

test('fails when the worker model is not in the catalog', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'gemini-2.5-flashh' },
    catalog: catalog([gemini], ['google']),
    pathValue: pathWithPi(),
  });

  const model = check(checks, 'worker model');
  assert.equal(model.status, 'fail');
  assert.match(model.detail, /gemini-2\.5-flashh/);
});

test('resolves a bare model id against the catalog', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'gemini-2.5-flash' },
    catalog: catalog([gemini], ['google']),
    pathValue: pathWithPi(),
  });

  const model = check(checks, 'worker model');
  assert.equal(model.status, 'ok');
  assert.match(model.detail, /google\/gemini-2\.5-flash/);
});

test('resolves a provider-qualified model id', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'anthropic/claude-sonnet-5' },
    catalog: catalog([gemini, sonnet], ['anthropic']),
    pathValue: pathWithPi(),
  });

  assert.equal(check(checks, 'worker model').status, 'ok');
  assert.equal(check(checks, 'worker auth').status, 'ok');
});

test('ignores a thinking-level suffix when resolving', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'anthropic/claude-sonnet-5:high' },
    catalog: catalog([sonnet], ['anthropic']),
    pathValue: pathWithPi(),
  });

  assert.equal(check(checks, 'worker model').status, 'ok');
});

test('warns when a bare id matches several providers', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'shared-id' },
    catalog: catalog(
      [
        { id: 'shared-id', provider: 'google' },
        { id: 'shared-id', provider: 'openai' },
      ],
      ['google', 'openai']
    ),
    pathValue: pathWithPi(),
  });

  const model = check(checks, 'worker model');
  assert.equal(model.status, 'warn');
  assert.match(model.detail, /google/);
  assert.match(model.detail, /openai/);
});

test('fails when the worker model provider has no credentials', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'gemini-2.5-flash' },
    catalog: catalog([gemini], []),
    pathValue: pathWithPi(),
  });

  const auth = check(checks, 'worker auth');
  assert.equal(auth.status, 'fail');
  assert.match(auth.detail, /google/);
});

test('skips the auth check when the model itself did not resolve', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'nope' },
    catalog: catalog([gemini], ['google']),
    pathValue: pathWithPi(),
  });

  assert.equal(check(checks, 'worker auth').status, 'warn');
  assert.match(check(checks, 'worker auth').detail, /not checked/i);
});

test('checks the write model separately when it differs', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'gemini-2.5-flash', writeModel: 'anthropic/claude-sonnet-5' },
    catalog: catalog([gemini, sonnet], ['google']),
    pathValue: pathWithPi(),
  });

  assert.equal(check(checks, 'worker auth').status, 'ok');
  assert.equal(check(checks, 'write model').status, 'ok');
  assert.equal(check(checks, 'write auth').status, 'fail', 'anthropic has no credentials');
});

test('does not duplicate checks when both tools share a model', () => {
  const checks = runDiagnostics({
    config: { ...baseConfig, workerModel: 'gemini-2.5-flash', writeModel: 'gemini-2.5-flash' },
    catalog: catalog([gemini], ['google']),
    pathValue: pathWithPi(),
  });

  assert.equal(checks.filter((c) => c.name.startsWith('write')).length, 0);
});

test('reports the resolved project root and worker timeout', () => {
  const checks = runDiagnostics({
    config: baseConfig,
    catalog: catalog([gemini], ['google']),
    pathValue: pathWithPi(),
  });

  assert.equal(check(checks, 'path policy').status, 'ok');
});

test('warns when the catalog is empty, rather than blaming the model', () => {
  const checks = runDiagnostics({
    config: baseConfig,
    catalog: catalog([], []),
    pathValue: pathWithPi(),
  });

  const model = check(checks, 'worker model');
  assert.equal(model.status, 'warn');
  assert.match(model.detail, /catalog/);
});

test('formatDiagnostics marks failures and summarizes', () => {
  const checks = runDiagnostics({
    config: baseConfig,
    catalog: catalog([gemini], []),
    pathValue: emptyPath(),
  });

  const text = formatDiagnostics(checks);
  assert.match(text, /FAIL/);
  assert.match(text, /worker binary/);
  assert.match(text, /2 failed/);
});

test('formatDiagnostics reports a clean run', () => {
  const checks = runDiagnostics({
    config: baseConfig,
    catalog: catalog([gemini], ['google']),
    pathValue: pathWithPi(),
  });

  assert.match(formatDiagnostics(checks), /all checks passed/i);
});

test('survives a missing model registry instead of throwing', () => {
  const checks = runDiagnostics({
    config: baseConfig,
    catalog: undefined as unknown as ModelCatalog,
    pathValue: pathWithPi(),
  });

  assert.equal(check(checks, 'worker model').status, 'warn');
  assert.match(check(checks, 'worker model').detail, /unavailable/i);
  assert.equal(check(checks, 'worker binary').status, 'ok', 'other checks still run');
});

test('survives a registry whose lookups throw', () => {
  const throwing: ModelCatalog = {
    getAll: () => [gemini],
    hasConfiguredAuth: () => {
      throw new Error('registry exploded');
    },
    getProviderDisplayName: (provider) => provider,
  };

  const checks = runDiagnostics({
    config: baseConfig,
    catalog: throwing,
    pathValue: pathWithPi(),
  });

  assert.equal(check(checks, 'worker model').status, 'ok');
  assert.equal(check(checks, 'worker auth').status, 'warn');
});
