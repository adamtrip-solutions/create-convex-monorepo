// @ts-check
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPERATING_SYSTEMS = ['ubuntu-latest', 'windows-latest'];

/**
 * Every tree gets the full generated-project matrix once, on the release PR
 * that release-please rebuilds after each merge. Feature PRs run the smoke
 * subset. Main and the release tag hold a tree a PR already verified.
 *
 * @param {{ eventName: string, headRef: string, releaseRef: string }} trigger
 * @param {unknown} matrix
 */
export function planCi({ eventName, headRef, releaseRef }, matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0)
    throw new Error('Expected a non-empty generated-project matrix.');
  const entries = matrix.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new Error('Expected every matrix entry to be an object.');
    return /** @type {Record<string, unknown>} */ (entry);
  });
  const full = entries.map(({ smoke: _smoke, ...entry }) => entry);
  const smoke = entries
    .filter((entry) => entry.smoke === true)
    .map(({ smoke: _smoke, ...entry }) => entry);
  if (smoke.length === 0) throw new Error('Expected at least one smoke entry.');

  // A reusable workflow inherits the caller's event name, so the release
  // verification is only recognizable by its ref input.
  if (releaseRef) return { os: OPERATING_SYSTEMS, projects: [] };
  if (eventName === 'push')
    return { os: OPERATING_SYSTEMS.slice(0, 1), projects: [] };
  if (eventName === 'pull_request' && !headRef.startsWith('release-please--'))
    return { os: OPERATING_SYSTEMS, projects: smoke };
  return { os: OPERATING_SYSTEMS, projects: full };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const matrix = JSON.parse(await readFile('.github/ci-matrix.json', 'utf8'));
  const plan = planCi(
    {
      eventName: process.env.EVENT_NAME ?? '',
      headRef: process.env.HEAD_REF ?? '',
      releaseRef: process.env.RELEASE_REF ?? '',
    },
    matrix,
  );
  console.log(
    `${plan.os.join(', ')}; ${plan.projects.length} generated projects`,
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `os=${JSON.stringify(plan.os)}\nprojects=${JSON.stringify(plan.projects)}\nproject-count=${plan.projects.length}\n`,
    );
}
