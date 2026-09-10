import { versions } from '../templates/versions.js';
import { getPackageVersion } from '../version.js';
import type { Workspace } from './project.js';

/** Read-only comparison against the official generator's latest stable release. */
export interface UpgradeCheck {
  cliVersion: string;
  projectGenerator: string;
  latestStable: string;
  updateAvailable: boolean;
  projectBehind: boolean;
  /** Versions tested together by the running CLI, not by the remote release. */
  baseline: typeof versions;
  registry: string;
}

function stableVersion(value: unknown): bigint[] {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  ) {
    throw new Error(
      'Expected a stable semantic version in generator release metadata.',
    );
  }
  return value
    .split('+')[0]!
    .split('.')
    .map((part) => BigInt(part));
}

function isNewer(latest: string, current: string): boolean {
  const target = stableVersion(latest);
  // A stable version supersedes a prerelease with the same core version.
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      current,
    );
  if (!match)
    throw new Error(
      'The project or CLI generator version is not a semantic version.',
    );
  if (
    match[4]
      ?.slice(1)
      .split('.')
      .some(
        (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'),
      )
  ) {
    throw new Error(
      'The project or CLI generator version is not a semantic version.',
    );
  }
  for (let index = 0; index < 3; index++) {
    const installed = BigInt(match[index + 1]!);
    if (target[index]! !== installed) return target[index]! > installed;
  }
  return Boolean(match[4]);
}

export async function checkUpgrade(
  workspace: Workspace,
  options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<UpgradeCheck> {
  options.signal?.throwIfAborted();
  const cliVersion = await getPackageVersion();
  options.signal?.throwIfAborted();
  const registry = 'https://registry.npmjs.org/create-convex-monorepo/latest';
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(
          new Error(
            options.signal?.aborted
              ? 'Upgrade check cancelled.'
              : 'The npm registry check timed out after 10 seconds.',
          ),
        );
      signal.addEventListener('abort', abortListener, { once: true });
      timer = setTimeout(() => controller.abort(), 10_000);
    });
    const request = (async () => {
      const response = await (options.fetch ?? globalThis.fetch)(registry, {
        signal,
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
      if (!response.ok)
        throw new Error(`The npm registry returned HTTP ${response.status}.`);
      const data: unknown = await response.json();
      if (typeof data !== 'object' || data === null || !('version' in data)) {
        throw new Error(
          'The npm registry returned invalid generator release metadata.',
        );
      }
      stableVersion(data.version);
      if (typeof data.version !== 'string')
        throw new Error('Invalid registry version.');
      return data.version;
    })();
    const latestStable = await Promise.race([request, cancelled]);
    return {
      cliVersion,
      projectGenerator: workspace.config.generator,
      latestStable,
      updateAvailable: isNewer(latestStable, cliVersion),
      projectBehind: isNewer(latestStable, workspace.config.generator),
      baseline: { ...versions },
      registry,
    };
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
    controller.abort();
  }
}
