import type { ProjectOptions } from '../../../generator/types.js';
import { scriptCommand } from '../../../package-manager/index.js';

export function betterAuthSetup(options: ProjectOptions): string {
  const run = (script: string) => scriptCommand(options.packageManager, script);
  const origins = options.apps.map((app, index) =>
    app.framework === 'expo'
      ? `ccm-${options.name}-${app.name}://`
      : `http://localhost:${3000 + index}`,
  );
  const site =
    origins.find((origin) => origin.startsWith('http')) ??
    'http://localhost:8081';
  const extra = origins.filter((origin) => origin !== site).join(',');
  return `## Better Auth setup

This starter uses the official Convex Better Auth component with email and password. Sign-up uses the email address as the account name. Email verification and social providers are disabled. Next.js, TanStack Start, and React Router use client authentication only.

From the workspace root:

\`\`\`sh
${run('convex:setup')}
${run('convex:better-auth-env')} --site-url ${site}${extra ? ` --trusted-origins ${extra}` : ''}
${run('convex:setup')}
\`\`\`

The first setup selects a deployment. If its push stops because auth variables are missing, run the environment command and retry setup. The script generates a random 32-byte BETTER_AUTH_SECRET and sets it, SITE_URL, and BETTER_AUTH_TRUSTED_ORIGINS through the installed Convex CLI in packages/backend. It never stores or prints the secret. A failed update can leave some variables set; rerun the same command to finish. Each run replaces the secret and the trusted origins list, so existing sessions may need to sign in again.

SITE_URL is the main frontend origin. BETTER_AUTH_TRUSTED_ORIGINS contains comma-separated additional web origins and native app schemes. Include every app that should sign in. For production, use your production origins and append --prod to generate a separate secret. To change origins without rotating the secret, use the installed Convex CLI's env set command for SITE_URL and BETTER_AUTH_TRUSTED_ORIGINS.

Append each app's .env.better-auth.example to its .env.local. Set its public CONVEX_SITE_URL variable to the deployment's HTTP action URL from the Convex dashboard, usually https://<deployment>.convex.site. Keep its existing public CONVEX_URL set to the client URL, usually https://<deployment>.convex.cloud. Local and self-hosted deployments have separate HTTP action URLs; do not derive them by replacing a hostname suffix. convex:link updates only CONVEX_URL. Restart dev servers after editing environment files.

Convex supplies the server-side CONVEX_SITE_URL. BETTER_AUTH_SECRET stays on the deployment and must never have a NEXT_PUBLIC_, VITE_, or EXPO_PUBLIC_ prefix. The component creates its own signing keys; no manual JWKS setting is required.

Expo uses expo-secure-store to persist sessions on native devices. Build a development client with ${run('ios')} or ${run('android')} so the configured ccm-${options.name}-<app> scheme is available. Add each scheme to the deployment's trusted origins. A phone needs reachable deployment URLs. Its localhost refers to the phone itself. Web clients use the cross-domain plugin; native clients use the Expo plugin.

${options.example === 'messages' ? "Messages use the Better Auth user ID returned by authComponent.getAuthUser(ctx) as their owner. Sessions for the same account share messages; different users cannot read one another's messages." : 'The blank starter has no application tables. Use authComponent.getAuthUser(ctx) and enforce authorization in protected functions you add.'} Auth tables live inside the component, so the application schema stays unchanged. Run ${run('convex:dev')} after changing backend modules to refresh generated types.

See the [official React setup](https://labs.convex.dev/better-auth/framework-guides/react) and [Expo setup](https://labs.convex.dev/better-auth/framework-guides/expo). Provider replacement is not supported.
`;
}
