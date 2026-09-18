import type { AppTemplate, Framework } from '../../generator/types.js';
import { nextTemplate } from './next/index.js';
import { viteTemplate } from './vite/index.js';
import { tanstackStartTemplate } from './tanstack-start/index.js';
import { reactRouterTemplate } from './react-router/index.js';
import { expoTemplate } from './expo/index.js';

export const appTemplates: Record<Framework, AppTemplate> = {
  next: nextTemplate,
  vite: viteTemplate,
  'tanstack-start': tanstackStartTemplate,
  'react-router': reactRouterTemplate,
  expo: expoTemplate,
};
