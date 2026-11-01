/**
 * Preflight diagnostics for pi-shunt.
 *
 * Delegation fails late and in the middle of a task: the main model gets
 * blocked from reading a file, calls shunt_read, and only then learns that the
 * worker model is misspelled or its provider has no credentials. These checks
 * answer the same questions up front.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ShuntConfig } from './config.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** The part of pi's ModelRegistry these checks need. */
export interface ModelCatalog {
  getAll(): Array<{ id: string; provider: string }>;
  hasConfiguredAuth(model: { id: string; provider: string }): boolean;
  getProviderDisplayName(provider: string): string;
}

export interface DiagnosticsInput {
  config: ShuntConfig;
  catalog: ModelCatalog;
  /** PATH to search for the worker binary. */
  pathValue: string | undefined;
  /** Project root the path policy confines to. */
  root?: string;
}

/** The binary the worker is spawned as. */
const WORKER_BINARY = 'pi';

export function runDiagnostics(input: DiagnosticsInput): Check[] {
  const { config, catalog } = input;
  const checks: Check[] = [binaryCheck(input.pathValue)];

  const models = safeModels(catalog);

  checks.push(...modelChecks('worker', config.workerModel, models, catalog));

  if (config.writeModel && config.writeModel !== config.workerModel) {
    checks.push(...modelChecks('write', config.writeModel, models, catalog));
  }

  checks.push(pathPolicyCheck(input.root ?? process.cwd()));

  return checks;
}

function binaryCheck(pathValue: string | undefined): Check {
  const found = findExecutable(WORKER_BINARY, pathValue);
  if (!found) {
    return {
      name: 'worker binary',
      status: 'fail',
      detail:
        `"${WORKER_BINARY}" not found on PATH. Workers are spawned as a subprocess, ` +
        `so delegation will fail until the launching PATH includes it.`,
    };
  }

  return { name: 'worker binary', status: 'ok', detail: found };
}

/** Resolve a configured model string and check its provider credentials. */
function modelChecks(
  label: 'worker' | 'write',
  configured: string,
  models: Array<{ id: string; provider: string }> | undefined,
  catalog: ModelCatalog
): Check[] {
  if (!models) {
    return [
      { name: `${label} model`, status: 'warn', detail: 'Model catalog unavailable, not checked.' },
      { name: `${label} auth`, status: 'warn', detail: 'Not checked: model did not resolve.' },
    ];
  }

  if (models.length === 0) {
    return [
      {
        name: `${label} model`,
        status: 'warn',
        detail: `Model catalog is empty, so "${configured}" could not be verified.`,
      },
      { name: `${label} auth`, status: 'warn', detail: 'Not checked: model did not resolve.' },
    ];
  }

  const matches = resolveModel(configured, models);

  if (matches.length === 0) {
    return [
      {
        name: `${label} model`,
        status: 'fail',
        detail: `"${configured}" matches no model in the catalog. Check the spelling, or run /models to list what is available.`,
      },
      { name: `${label} auth`, status: 'warn', detail: 'Not checked: model did not resolve.' },
    ];
  }

  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.provider}/${m.id}`).join(', ');
    return [
      {
        name: `${label} model`,
        status: 'warn',
        detail: `"${configured}" matches several models (${candidates}). Qualify it as provider/id to pick one.`,
      },
      { name: `${label} auth`, status: 'warn', detail: 'Not checked: model is ambiguous.' },
    ];
  }

  const model = matches[0];
  const resolved = `${model.provider}/${model.id}`;

  return [
    { name: `${label} model`, status: 'ok', detail: resolved },
    authCheck(label, model, catalog),
  ];
}

function authCheck(
  label: string,
  model: { id: string; provider: string },
  catalog: ModelCatalog
): Check {
  let configured = false;
  try {
    configured = catalog.hasConfiguredAuth(model);
  } catch {
    return {
      name: `${label} auth`,
      status: 'warn',
      detail: `Could not determine credentials for ${model.provider}.`,
    };
  }

  if (!configured) {
    const provider = displayName(catalog, model.provider);
    return {
      name: `${label} auth`,
      status: 'fail',
      detail: `No credentials configured for ${provider}. Run "pi auth" or set the provider's API key env var.`,
    };
  }

  return { name: `${label} auth`, status: 'ok', detail: displayName(catalog, model.provider) };
}

function pathPolicyCheck(root: string): Check {
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) {
      return { name: 'path policy', status: 'fail', detail: `Project root is not a directory: ${root}` };
    }
    return { name: 'path policy', status: 'ok', detail: `Confined to ${root}` };
  } catch {
    return {
      name: 'path policy',
      status: 'fail',
      detail: `Project root is unreadable: ${root}. Every shunt path resolves against it.`,
    };
  }
}

/**
 * Match a configured model string against the catalog.
 *
 * Accepts `provider/id` and a bare `id`, with an optional `:thinking` suffix,
 * mirroring what pi's own `--model` flag takes. A bare id can match several
 * providers, so every match is returned and the caller decides.
 */
export function resolveModel(
  configured: string,
  models: Array<{ id: string; provider: string }>
): Array<{ id: string; provider: string }> {
  const withoutThinking = configured.split(':')[0].trim();
  const slash = withoutThinking.indexOf('/');

  if (slash > 0) {
    const provider = withoutThinking.slice(0, slash);
    const id = withoutThinking.slice(slash + 1);
    return models.filter((m) => m.provider === provider && m.id === id);
  }

  return models.filter((m) => m.id === withoutThinking);
}

/** Find an executable on a PATH value, without shelling out. */
export function findExecutable(name: string, pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

export function formatDiagnostics(checks: Check[]): string {
  const marker: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;

  const lines = checks.map(
    (c) => `${marker[c.status]}  ${c.name.padEnd(width)}${c.detail}`
  );

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;

  const summary =
    failed === 0 && warned === 0
      ? 'All checks passed.'
      : [failed > 0 ? `${failed} failed` : '', warned > 0 ? `${warned} warned` : '']
          .filter(Boolean)
          .join(', ') + '.';

  return ['pi-shunt diagnostics', '===================', ...lines, '', summary].join('\n');
}

function safeModels(catalog: ModelCatalog): Array<{ id: string; provider: string }> | undefined {
  try {
    return catalog.getAll();
  } catch {
    return undefined;
  }
}

function displayName(catalog: ModelCatalog, provider: string): string {
  try {
    return catalog.getProviderDisplayName(provider) || provider;
  } catch {
    return provider;
  }
}
