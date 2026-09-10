import { readdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type ts from 'typescript';
import {
  deploymentUrl,
  publicVariable,
} from '../../assets/setup/convex-setup.mjs';
import type { Framework } from '../generator/types.js';
import { versions } from '../templates/versions.js';
import { readJson, readText, type Workspace } from './project.js';

export interface DoctorIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
}
export interface DoctorResult {
  issues: DoctorIssue[];
  /** Successfully completed checks, including explicit limits of static checks. */
  checks: string[];
}

const frameworks: Record<Framework, string[]> = {
  next: ['next', 'react-dom'],
  vite: ['vite', '@vitejs/plugin-react', 'react-dom'],
  'tanstack-start': ['@tanstack/react-start', 'vite', 'react-dom'],
  expo: ['expo', 'react-native'],
};
const clerk: Record<Framework, string> = {
  next: '@clerk/nextjs',
  vite: '@clerk/react',
  'tanstack-start': '@clerk/tanstack-react-start',
  expo: '@clerk/expo',
};
const baselines: Record<string, string> = {
  convex: versions.convex,
  react: versions.react,
  typescript: versions.typescript,
  next: versions.next,
  vite: versions.vite,
  expo: versions.expo,
  'react-native': versions.reactNative,
  '@tanstack/react-start': versions.tanstackStart,
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function validUrl(value: string | undefined): boolean {
  try {
    deploymentUrl(value);
    return true;
  } catch {
    return false;
  }
}

/** Recognize the generator's block list and simple inline lists, not general YAML. */
function workspacePatterns(source: string): {
  patterns: string[];
  unsupported: boolean;
} {
  const lines = source.split(/\r?\n/);
  const headers = lines
    .map((line, index) => (/^packages\s*:\s*(.*)$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (headers.length !== 1) return { patterns: [], unsupported: true };
  const index = headers[0]!;
  const inline = /^packages\s*:\s*(.*)$/.exec(lines[index]!)![1]!.trim();
  const patterns: string[] = [];
  let unsupported = false;
  function entry(raw: string) {
    const trimmed = raw.trim();
    const quoted = /^(['"])([^'"]*)\1\s*(?:#.*)?$/.exec(trimmed);
    const pattern = quoted ? quoted[2]! : trimmed.replace(/\s+#.*$/, '').trim();
    if (
      (!quoted && /^[!&*]/.test(pattern)) ||
      !/^!?[A-Za-z0-9_.*\/-]+$/.test(pattern) ||
      pattern.includes('**') ||
      pattern
        .split('/')
        .some(
          (part) =>
            part !== '*' &&
            (part.includes('*') || part === '..' || part === '.'),
        )
    ) {
      unsupported = true;
      return;
    }
    patterns.push(pattern);
  }
  if (inline && !inline.startsWith('#')) {
    const list = /^\[([^\]]*)\]\s*(?:#.*)?$/.exec(inline);
    if (!list) return { patterns, unsupported: true };
    if (list[1]!.trim()) for (const item of list[1]!.split(',')) entry(item);
  } else {
    for (const line of lines.slice(index + 1)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (/^[^\s-]/.test(line)) break;
      const item = /^ *-\s+(.+)$/.exec(line);
      if (!item) unsupported = true;
      else entry(item[1]!);
    }
  }
  return { patterns, unsupported };
}
function matchesWorkspacePattern(pattern: string, path: string): boolean {
  const segments = pattern.split('/');
  const target = path.split('/');
  return (
    segments.length === target.length &&
    segments.every(
      (segment, index) => segment === '*' || segment === target[index],
    )
  );
}

async function installedVersion(
  root: string,
  directory: string,
  name: string,
): Promise<string | null> {
  const require = createRequire(join(root, directory, 'package.json'));
  let manifest: string;
  try {
    manifest = require.resolve(`${name}/package.json`);
  } catch {
    try {
      let cursor = dirname(require.resolve(name));
      for (;;) {
        const candidate = join(cursor, 'package.json');
        try {
          const data: unknown = JSON.parse(await readFile(candidate, 'utf8'));
          if (object(data).name === name) {
            manifest = candidate;
            break;
          }
        } catch {
          /* Continue toward the package root. */
        }
        const parent = dirname(cursor);
        if (parent === cursor) return null;
        cursor = parent;
      }
    } catch {
      return null;
    }
  }
  // Avoid accidentally treating a dependency in an ancestor project as installed here.
  const path = relative(await realpath(root), await realpath(manifest));
  if (path.startsWith('..') || !path.split(/[\\/]/).includes('node_modules'))
    return null;
  try {
    const data: unknown = JSON.parse(await readFile(manifest, 'utf8'));
    return typeof object(data).version === 'string'
      ? (object(data).version as string)
      : null;
  } catch {
    return null;
  }
}

/** Inspect files and installed types without running project scripts or writing probes. */
export async function doctor(
  workspace: Workspace,
  options: { signal?: AbortSignal } = {},
): Promise<DoctorResult> {
  const { root, config } = workspace;
  const result: DoctorResult = { issues: [], checks: [] };
  const issue = (
    code: string,
    message: string,
    fix: string,
    severity: DoctorIssue['severity'] = 'error',
  ) => result.issues.push({ code, severity, message, fix });
  const checkAbort = () => options.signal?.throwIfAborted();
  async function text(path: string): Promise<string | null> {
    checkAbort();
    try {
      return await readText(root, path);
    } catch {
      issue(
        'unsafe-file',
        `Cannot safely read ${path}.`,
        'Use a regular file inside this workspace.',
      );
      return null;
    }
  }
  async function environment(
    directory: string,
  ): Promise<Map<string, string | undefined>> {
    let values: Record<string, string | undefined> = {};
    for (const filename of ['.env', '.env.local']) {
      const path = `${directory}/${filename}`;
      const contents = await text(path);
      try {
        values = { ...values, ...parseEnv(contents ?? '') };
      } catch {
        issue(
          'env-invalid',
          `${path} could not be parsed.`,
          'Repair this environment file without sharing its values.',
        );
      }
    }
    return new Map(Object.entries(values));
  }
  async function manifest(path: string): Promise<Record<string, unknown>> {
    checkAbort();
    try {
      return await readJson(root, path);
    } catch {
      issue(
        'manifest-invalid',
        `${path} is missing, unsafe, or invalid JSON.`,
        'Restore a valid package manifest.',
      );
      return {};
    }
  }
  const rootManifest = await manifest('package.json');
  if (rootManifest.name !== config.name)
    issue(
      'workspace-name',
      'The root package name does not match convex-monorepo.json.',
      'Align the root package name with the workspace metadata.',
    );
  if (rootManifest.packageManager !== `pnpm@${versions.pnpm}`) {
    issue(
      'package-manager-baseline',
      'The root packageManager differs from this CLI’s tested pnpm version.',
      `Review packageManager against pnpm@${versions.pnpm}.`,
      'warning',
    );
  }
  for (const path of [
    'pnpm-workspace.yaml',
    'turbo.json',
    'packages/backend/convex/tsconfig.json',
    'packages/backend/convex/schema.ts',
  ]) {
    if ((await text(path)) === null)
      issue(
        'file-missing',
        `${path} is missing.`,
        'Restore the workspace configuration file.',
      );
  }
  const workspaceYaml = await text('pnpm-workspace.yaml');
  if (workspaceYaml !== null) {
    const layout = workspacePatterns(workspaceYaml);
    if (layout.unsupported)
      issue(
        'workspace-layout-unverified',
        'pnpm-workspace.yaml uses syntax or package patterns outside the doctor’s static checks.',
        'Review pnpm package selection manually or use the generated apps/* and packages/* lists.',
        'warning',
      );
    for (const directory of [
      'packages/backend',
      ...config.apps.map((app) => `apps/${app.name}`),
    ]) {
      const excluded = layout.patterns.some(
        (pattern) =>
          pattern.startsWith('!') &&
          matchesWorkspacePattern(pattern.slice(1), directory),
      );
      const included = layout.patterns.some(
        (pattern) =>
          !pattern.startsWith('!') &&
          matchesWorkspacePattern(pattern, directory),
      );
      if (excluded || (!included && !layout.unsupported))
        issue(
          'workspace-package-excluded',
          `pnpm-workspace.yaml excludes ${directory} from the workspace.`,
          'Include each recorded app and packages/backend in the pnpm packages list.',
        );
    }
    if (
      !layout.unsupported &&
      !result.issues.some((item) => item.code === 'workspace-package-excluded')
    )
      result.checks.push(
        'The pnpm package list includes all recorded apps and the backend under supported static patterns.',
      );
  }
  for (const path of ['turbo.json', 'packages/backend/convex.json']) {
    const source = await text(path);
    if (source !== null) {
      try {
        const parsed: unknown = JSON.parse(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error();
        if (path === 'turbo.json') {
          const tasks = object(object(parsed).tasks);
          for (const task of ['dev', 'build', 'typecheck', 'lint']) {
            if (
              !tasks[task] ||
              typeof tasks[task] !== 'object' ||
              Array.isArray(tasks[task])
            )
              issue(
                'turbo-task-missing',
                `turbo.json has no valid ${task} task configuration.`,
                'Restore the generated Turbo task or review the workspace scripts that invoke it.',
              );
          }
        }
      } catch {
        issue(
          'config-invalid',
          `${path} must contain a JSON object.`,
          'Restore valid workspace configuration.',
        );
      }
    } else if (path !== 'turbo.json')
      issue(
        'file-missing',
        `${path} is missing.`,
        'Restore the backend configuration.',
      );
  }
  try {
    // Validate the apps parent before enumerating, since it may itself be a symlink.
    await readText(root, 'apps/.doctor-parent-check');
    for (const entry of await readdir(join(root, 'apps'), {
      withFileTypes: true,
    })) {
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        !config.apps.some((app) => app.name === entry.name)
      ) {
        issue(
          'untracked-app',
          `apps/${entry.name} is not recorded in convex-monorepo.json.`,
          'Review this directory and add matching app metadata if it belongs to the workspace.',
          'warning',
        );
      }
    }
  } catch {
    issue(
      'apps-directory',
      'The apps directory is missing or unsafe.',
      'Restore the apps directory inside the workspace.',
    );
  }
  if (
    config.auth === 'clerk' &&
    (await text('packages/backend/convex/auth.config.ts')) === null
  ) {
    issue(
      'auth-config-missing',
      'Clerk is recorded in metadata but the backend auth.config.ts is missing.',
      'Restore the backend Clerk auth configuration before deploying.',
    );
  }
  const backend = await manifest('packages/backend/package.json');
  const backendName = typeof backend.name === 'string' ? backend.name : '';
  if (backendName !== `@${config.name}/backend`)
    issue(
      'backend-name',
      'The backend package name does not match the workspace metadata.',
      'Align the backend package name and app workspace dependencies with the metadata.',
    );
  const exports = object(backend.exports);
  for (const [key, expected] of [
    ['./api', 'api.d.ts'],
    ['./dataModel', 'dataModel.d.ts'],
  ]) {
    const declaration = object(exports[key!]).types;
    if (typeof declaration !== 'string') {
      issue(
        'backend-exports',
        `The backend ${key} export has no types condition.`,
        'Restore a types export pointing to a Convex generated declaration.',
      );
    } else if (
      (await text(`packages/backend/${declaration.replace(/^\.\//, '')}`)) ===
      null
    ) {
      issue(
        'backend-declarations',
        `The backend ${key} declaration is missing or unsafe.`,
        `Run pnpm --filter ${backendName || './packages/backend'} exec convex codegen after reviewing the deployment configuration.`,
      );
    } else
      result.checks.push(`Backend ${key} declaration exists (${expected}).`);
  }
  const apiRuntime = object(exports['./api']).default;
  if (
    typeof apiRuntime !== 'string' ||
    (await text(`packages/backend/${apiRuntime.replace(/^\.\//, '')}`)) === null
  ) {
    issue(
      'backend-runtime',
      'The backend API runtime export is missing or unsafe.',
      'Restore the API default export and generated api.js.',
    );
  }
  const backendEnv = await environment('packages/backend');
  const backendUrl = backendEnv.get('CONVEX_URL');
  if (!validUrl(backendUrl))
    issue(
      'backend-url',
      'The backend CONVEX_URL is missing or invalid.',
      'Run pnpm convex:setup to configure the backend deployment.',
    );
  else result.checks.push('Backend CONVEX_URL is a valid HTTP(S) origin.');
  const resolved = new Map<string, Map<string, string>>();
  async function dependencies(
    directory: string,
    pkg: Record<string, unknown>,
    required: string[],
  ) {
    const declared = {
      ...object(pkg.dependencies),
      ...object(pkg.devDependencies),
    };
    const found = new Map<string, string>();
    resolved.set(directory, found);
    for (const name of required) {
      checkAbort();
      if (typeof declared[name] !== 'string') {
        issue(
          'dependency-missing',
          `${directory || 'root'} does not declare ${name}.`,
          'Restore the required dependency and run pnpm install.',
        );
        continue;
      }
      const installed = await installedVersion(root, directory, name);
      if (!installed) {
        issue(
          'dependency-uninstalled',
          `${name} cannot be resolved from ${directory || 'root'}.`,
          'Run pnpm install from the workspace root.',
        );
        continue;
      }
      found.set(name, installed);
      if (
        /^\d+\.\d+\.\d+$/.test(declared[name]) &&
        declared[name] !== installed
      ) {
        issue(
          'dependency-version',
          `${directory || 'root'} resolves ${name}@${installed}, which differs from its declared version.`,
          'Run pnpm install and review the lockfile.',
        );
      }
      if (baselines[name] && baselines[name] !== installed) {
        issue(
          'dependency-baseline',
          `${directory || 'root'} resolves ${name}@${installed}, outside this CLI’s tested baseline.`,
          `Review compatibility with the tested ${name}@${baselines[name]} baseline.`,
          'warning',
        );
      }
    }
  }
  await dependencies('', rootManifest, ['turbo']);
  await dependencies('packages/backend', backend, ['convex', 'typescript']);
  for (const app of config.apps) {
    const directory = `apps/${app.name}`;
    const pkg = await manifest(`${directory}/package.json`);
    await dependencies(directory, pkg, [
      'convex',
      'react',
      'typescript',
      ...frameworks[app.framework],
      ...(config.auth === 'clerk' ? [clerk[app.framework]] : []),
    ]);
    if (
      !backendName ||
      typeof object(pkg.dependencies)[backendName] !== 'string'
    ) {
      issue(
        'backend-dependency',
        `${directory} does not declare the backend workspace package.`,
        'Add the backend package with a workspace dependency.',
      );
    }
    const prefix =
      app.framework === 'next'
        ? 'NEXT_PUBLIC'
        : app.framework === 'expo'
          ? 'EXPO_PUBLIC'
          : 'VITE';
    const env = await environment(directory);
    for (const secret of ['CLERK_SECRET_KEY', 'CONVEX_DEPLOY_KEY']) {
      if (env.get(`${prefix}_${secret}`))
        issue(
          'public-secret',
          `${directory} exposes ${secret} through a public environment variable.`,
          'Remove the public assignment, rotate the exposed credential, and rebuild the app.',
        );
    }
    const key = publicVariable(app.framework);
    if (!validUrl(env.get(key)))
      issue(
        'app-url',
        `${directory} has a missing or invalid ${key}.`,
        'Run pnpm convex:link after configuring the backend.',
      );
    else if (
      validUrl(backendUrl) &&
      new URL(env.get(key)!).origin !== new URL(backendUrl!).origin
    ) {
      issue(
        'app-url-mismatch',
        `${directory} ${key} does not match the backend deployment URL.`,
        'Run pnpm convex:link, then restart the app.',
      );
    } else if (validUrl(backendUrl))
      result.checks.push(`${directory} uses the backend deployment URL.`);
    if (config.auth === 'clerk') {
      const required = [
        `${prefix}_CLERK_PUBLISHABLE_KEY`,
        ...(app.framework === 'next' || app.framework === 'tanstack-start'
          ? ['CLERK_SECRET_KEY']
          : []),
      ];
      for (const name of required)
        if (!env.get(name))
          issue(
            'auth-env-missing',
            `${directory} is missing ${name}.`,
            'Set the key in this app’s private .env.local.',
          );
    }
    if ((await text(`${directory}/tsconfig.json`)) === null)
      issue(
        'app-tsconfig',
        `${directory}/tsconfig.json is missing.`,
        'Restore the app TypeScript configuration.',
      );
    if (app.framework === 'expo') {
      const metro =
        (await text(`${directory}/metro.config.cjs`)) ??
        (await text(`${directory}/metro.config.js`));
      if (metro === null)
        issue(
          'metro-config',
          `${directory} has no Metro configuration.`,
          'Restore the Expo Metro configuration.',
        );
      else {
        if (!/['"]expo\/metro-config['"]/.test(metro)) {
          issue(
            'metro-custom',
            `${directory} Metro configuration does not directly reference expo/metro-config.`,
            'Review that the custom configuration inherits Expo workspace resolution defaults.',
            'warning',
          );
        }
        if (/disableHierarchicalLookup\s*:\s*true/.test(metro)) {
          issue(
            'metro-resolution',
            `${directory} Metro configuration disables hierarchical lookup.`,
            'Review this override against Expo workspace package resolution.',
            'warning',
          );
        }
        result.checks.push(
          `${directory} Metro configuration exists; custom configuration and native execution were not evaluated.`,
        );
      }
    }
    if (backendName && resolved.get(directory)?.has('typescript')) {
      checkAbort();
      try {
        const failure = probeTypes(root, directory, backendName);
        if (failure)
          issue(
            'backend-types',
            `${directory} cannot consume typed backend exports (${failure}).`,
            'Restore backend exports and generated declarations, then install dependencies and run the app typecheck.',
          );
        else
          result.checks.push(
            `${directory} resolves backend API and data model types without an untyped API.`,
          );
      } catch {
        issue(
          'type-probe',
          `${directory} TypeScript probe could not run.`,
          'Install this app’s TypeScript dependency and review tsconfig.json.',
        );
      }
    }
  }
  for (const name of ['convex', 'react']) {
    const versionsFound = new Set(
      [...resolved.values()]
        .map((deps) => deps.get(name))
        .filter((value) => value !== undefined),
    );
    if (versionsFound.size > 1)
      issue(
        'dependency-incompatible',
        `Workspace packages resolve different ${name} versions.`,
        `Align ${name} versions across packages and run pnpm install.`,
      );
  }
  if (config.auth === 'clerk')
    result.checks.push(
      'Clerk deployment issuer configuration requires a separate Convex deployment check; no remote secrets were read.',
    );
  checkAbort();
  return result;
}

function probeTypes(
  root: string,
  directory: string,
  backend: string,
): string | null {
  const require = createRequire(join(root, directory, 'package.json'));
  const compiler = require('typescript') as typeof ts;
  const configPath = join(root, directory, 'tsconfig.json');
  const config = compiler.readConfigFile(configPath, compiler.sys.readFile);
  if (config.error) return `TS${config.error.code}`;
  const parsed = compiler.parseJsonConfigFileContent(
    config.config,
    compiler.sys,
    dirname(configPath),
  );
  if (parsed.errors.some((error) => error.code !== 18003))
    return `TS${parsed.errors[0]!.code}`;
  const file = join(root, directory, '__ccm_doctor_probe__.ts');
  const source = `import { api } from ${JSON.stringify(`${backend}/api`)};\nimport type { DataModel } from ${JSON.stringify(`${backend}/dataModel`)};\ntype Assert<T extends false> = T;\nexport type ApiIsTyped = Assert<0 extends (1 & typeof api) ? true : false>;\nexport type ModelIsTyped = Assert<0 extends (1 & DataModel) ? true : false>;\nexport type ApiHasKnownKeys = Assert<string extends keyof typeof api ? true : false>;\n`;
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    composite: false,
    skipLibCheck: true,
  };
  const host = compiler.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalSource = host.getSourceFile.bind(host);
  host.readFile = (path) =>
    resolve(path) === file ? source : originalRead(path);
  host.fileExists = (path) => resolve(path) === file || originalExists(path);
  host.getSourceFile = (
    path,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    resolve(path) === file
      ? compiler.createSourceFile(file, source, languageVersion, true)
      : originalSource(
          path,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
  const program = compiler.createProgram([file], options, host);
  const errors = compiler
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) => diagnostic.category === compiler.DiagnosticCategory.Error,
    );
  if (errors.length)
    return [...new Set(errors.map((error) => `TS${error.code}`))].join(', ');
  const probe = program.getSourceFile(file);
  if (!probe) return 'probe source unavailable';
  const checker = program.getTypeChecker();
  const seen = new Set<ts.Type>();
  function untypedBranch(type: ts.Type, node: ts.Node): boolean {
    if (type.flags & compiler.TypeFlags.Any) return true;
    if (!(type.flags & compiler.TypeFlags.Object) || seen.has(type))
      return false;
    seen.add(type);
    // Convex function references are leaves. Their argument and return validators
    // may intentionally accept arbitrary values, which this check does not audit.
    if (checker.getPropertyOfType(type, '_type')) return false;
    if (checker.getIndexTypeOfType(type, compiler.IndexKind.String))
      return true;
    return checker
      .getPropertiesOfType(type)
      .some((property) =>
        untypedBranch(checker.getTypeOfSymbolAtLocation(property, node), node),
      );
  }
  for (const statement of probe.statements) {
    if (!compiler.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !compiler.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (
        binding.name.text === 'api' &&
        untypedBranch(checker.getTypeAtLocation(binding.name), binding.name)
      ) {
        return 'untyped API module or function reference';
      }
    }
  }
  return null;
}
