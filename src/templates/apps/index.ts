import type { AppTemplate, Framework } from '../../generator/types.js';
import { nuxtTemplate } from './nuxt/index.js';
import { nextTemplate } from './next/index.js';
import { viteTemplate } from './vite/index.js';
import { tanstackStartTemplate } from './tanstack-start/index.js';
import { expoTemplate } from './expo/index.js';

export const appTemplates: Record<Framework, AppTemplate> = {
  nuxt: nuxtTemplate,
  next: nextTemplate,
  vite: viteTemplate,
  'tanstack-start': tanstackStartTemplate,
  expo: expoTemplate,
};
