#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runCreate } from '../commands/create.js';

const controller = new AbortController();
const interrupt = () => controller.abort(new Error('Generation interrupted.'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  const manifest: { version: string } = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  await runCreate(process.argv.slice(2), manifest.version, controller.signal);
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
