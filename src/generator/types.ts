export type Framework = 'next' | 'vite' | 'tanstack-start' | 'expo';
export type Auth = 'none' | 'clerk' | 'convex-auth';
export type Example = 'none' | 'messages';
export interface AppSpec {
  name: string;
  framework: Framework;
}
export interface ProjectOptions {
  name: string;
  apps: AppSpec[];
  auth: Auth;
  example: Example;
  packageManager: 'pnpm';
  install: boolean;
  initConvex: boolean;
  git: boolean;
}
export interface PackageManifest {
  name: string;
  version?: string;
  private?: boolean;
  type?: 'module' | 'commonjs';
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}
export interface GeneratorContext {
  options: ProjectOptions;
  /** Filesystem staging directory owned by this generation. */
  root: string;
  scope: string;
  write(path: string, contents: string): Promise<void>;
  json(path: string, value: unknown): Promise<void>;
  mergePackage(path: string, patch: Partial<PackageManifest>): Promise<void>;
}
export interface AppTemplate {
  id: Framework;
  label: string;
  generate(context: GeneratorContext, app: AppSpec): Promise<void>;
}
export interface AuthAdapter {
  id: Auth;
  label: string;
  apply(context: GeneratorContext): Promise<void>;
}
