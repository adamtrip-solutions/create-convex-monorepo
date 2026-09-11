import { extname } from 'node:path';
import { format, type Options } from 'prettier';

export const formattingOptions = {
  singleQuote: true,
  trailingComma: 'all',
  endOfLine: 'lf',
} satisfies Options;

const extensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.md',
  '.yaml',
  '.yml',
]);

/** Format only authored output, with no config/plugin discovery or subprocess. */
export async function formatGeneratedFile(
  path: string,
  source: string,
): Promise<string> {
  if (
    path.split('/').includes('_generated') ||
    path.endsWith('/routeTree.gen.ts')
  )
    return source;
  if (!extensions.has(extname(path))) return source;
  return format(source, { ...formattingOptions, filepath: path });
}

/** Accept formatting differences in older starters, but retain code/comment conflicts. */
export async function equivalentGeneratedFile(
  path: string,
  left: string | null | undefined,
  right: string | null | undefined,
): Promise<boolean> {
  if (left == null || right == null) return left === right;
  if (left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n')) return true;
  try {
    return (
      (await formatGeneratedFile(path, left)) ===
      (await formatGeneratedFile(path, right))
    );
  } catch {
    return false;
  }
}
