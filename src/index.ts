export { generateProject } from './generator/index.js';
export { normalizeOptions } from './generator/options.js';
export type {
  GeneratorContext,
  ProjectOptions,
  AppSpec,
  AppTemplate,
  AuthAdapter,
  Framework,
  Auth,
  Example,
} from './generator/types.js';

export type { RawOptions } from './generator/options.js';
export type { GenerateSettings } from './generator/index.js';

export { loadWorkspace, parseWorkspaceConfig } from './workspace/project.js';
export type {
  Workspace,
  WorkspaceApp,
  WorkspaceConfig,
} from './workspace/project.js';
export { applyPlan } from './workspace/changes.js';
export type {
  ChangePlan,
  FileChange,
  ApplySettings,
} from './workspace/changes.js';
export { planAddApp, planAddAuth } from './workspace/add.js';
export { planEnvSync } from './workspace/env.js';
export { doctor } from './workspace/doctor.js';
export type { DoctorResult, DoctorIssue } from './workspace/doctor.js';
export { checkUpgrade } from './workspace/upgrade.js';
export type { UpgradeCheck } from './workspace/upgrade.js';
