#!/usr/bin/env node
import { getPackageVersion } from '../version.js';
import { runEntry } from '../commands/entry.js';

const controller = new AbortController();
const interrupt = () => controller.abort(new Error('Command interrupted.'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  await runEntry(
    process.argv.slice(2),
    await getPackageVersion(),
    controller.signal,
  );
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
