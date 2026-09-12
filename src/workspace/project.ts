import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeOptions, validateProjectName } from '../generator/options.js';
import type { AppSpec, Auth, Example } from '../generator/types.js';

export interface WorkspaceApp extends AppSpec {
  example?: Example;
}
export interface WorkspaceConfig {
  version: 1;
  generator: string;
  name: string;
  packageManager: 'pnpm';
  monorepo: 'turbo';
  apps: WorkspaceApp[];
  packages?: Array<{ name: string }>;
  auth: Auth;
  example: Example;
}
export interface Workspace {
  root: string;
  config: WorkspaceConfig;
  rawConfig: Record<string, unknown>;
  configText: string;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Check every existing path component, including the workspace root. */
export async function safePath(root: string, path: string): Promise<string> {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error(`Unsafe workspace path: ${path}`);
  root = resolve(root);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Unsafe workspace path: ${path}`);
  let current = root;
  for (const part of ['', ...rel.split(sep)]) {
    if (part) current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`Refusing symlink in workspace path: ${path}`);
      if (current !== target && !stat.isDirectory())
        throw new Error(`Expected a directory in workspace path: ${path}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return target;
}
export async function readText(
  root: string,
  path: string,
): Promise<string | null> {
  const target = await safePath(root, path);
  try {
    const stat = await lstat(target);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    if (stat.nlink > 1)
      throw new Error(`Refusing a hard-linked workspace file: ${path}`);
    if (stat.size > 5 * 1024 * 1024)
      throw new Error(`Workspace file is too large: ${path}`);
    return await readFile(target, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
export async function readJson(
  root: string,
  path: string,
): Promise<Record<string, unknown>> {
  const text = await readText(root, path);
  if (text === null) throw new Error(`Missing workspace file: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path}.`);
  }
  if (!isRecord(value)) throw new Error(`Expected a JSON object in ${path}.`);
  return value;
}
export function parseWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (!isRecord(value) || value.version !== 1)
    throw new Error(
      'Unsupported convex-monorepo.json version. This CLI supports version 1.',
    );
  if (
    typeof value.name !== 'string' ||
    typeof value.generator !== 'string' ||
    value.generator.length > 256 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value.generator,
    ) ||
    value.packageManager !== 'pnpm' ||
    value.monorepo !== 'turbo' ||
    !Array.isArray(value.apps) ||
    !['none', 'clerk'].includes(String(value.auth))
  )
    throw new Error(
      'Invalid convex-monorepo.json. Expected a named pnpm/Turborepo workspace with applications and a supported auth provider.',
    );
  if (value.packages !== undefined && !Array.isArray(value.packages))
    throw new Error(
      'Invalid packages list in convex-monorepo.json. Expected an array.',
    );
  const packages = ((value.packages as unknown[] | undefined) ?? []).map(
    (pkg) => {
      if (
        !isRecord(pkg) ||
        typeof pkg.name !== 'string' ||
        validateProjectName(pkg.name)
      )
        throw new Error(
          'Invalid package in convex-monorepo.json. Expected an object with a valid package name.',
        );
      return { name: pkg.name };
    },
  );
  const apps: WorkspaceApp[] = value.apps.map((app: unknown) => {
    if (
      !isRecord(app) ||
      typeof app.name !== 'string' ||
      typeof app.framework !== 'string'
    )
      throw new Error('Invalid application in convex-monorepo.json.');
    if (
      app.example !== undefined &&
      app.example !== 'none' &&
      app.example !== 'messages'
    )
      throw new Error(`Invalid starter content for ${app.name}.`);
    const normalized = normalizeOptions({
      name: value.name as string,
      apps: [
        { name: app.name, framework: app.framework as AppSpec['framework'] },
      ],
    }).apps[0];
    if (!normalized)
      throw new Error('Invalid application in convex-monorepo.json.');
    return {
      ...normalized,
      ...(app.example === undefined ? {} : { example: app.example }),
    };
  });
  const options = normalizeOptions({
    name: value.name,
    apps,
    auth: String(value.auth),
    ...(value.example === undefined ? {} : { example: String(value.example) }),
  });
  return {
    version: 1,
    generator: value.generator,
    name: options.name,
    packageManager: 'pnpm',
    monorepo: 'turbo',
    apps,
    packages,
    auth: options.auth,
    example: options.example,
  };
}
export async function loadWorkspace(
  cwd: string = process.cwd(),
): Promise<Workspace> {
  let root = resolve(cwd);
  while (true) {
    const configText = await readText(root, 'convex-monorepo.json');
    if (configText !== null) {
      let value: unknown;
      try {
        value = JSON.parse(configText);
      } catch {
        throw new Error('Invalid JSON in convex-monorepo.json.');
      }
      const config = parseWorkspaceConfig(value);
      if (!isRecord(value)) throw new Error('Invalid workspace metadata.');
      return { root, config, rawConfig: value, configText };
    }
    const parent = dirname(root);
    if (parent === root)
      throw new Error(
        'No convex-monorepo.json found. Run this command inside a generated workspace.',
      );
    root = parent;
  }
}
