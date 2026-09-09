import { readFile } from 'node:fs/promises';

export async function getPackageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  )
    throw new Error(
      'The generator package is missing its version. Reinstall it.',
    );
  return manifest.version;
}
