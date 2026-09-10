/** Shared runtime helpers, also copied into generated projects as plain JavaScript. */
export function publicVariable(framework: string): string;
export function deploymentUrl(value: string | undefined): string;
export function linkEnvironment(
  contents: string,
  variable: string,
  url: string,
): string;
export function linkFrontends(
  root: string,
  signal?: AbortSignal,
): Promise<void>;
export function initializeConvex(
  root: string,
  signal?: AbortSignal,
): Promise<void>;
