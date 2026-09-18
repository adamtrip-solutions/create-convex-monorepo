import type {
  PackageManagerId,
  OAuthProvider,
} from '../../../generator/types.js';
import {
  scriptCommand,
  workspaceExec,
} from '../../../package-manager/index.js';
export function convexAuthSetup(
  scope: string,
  messages: boolean,
  manager: PackageManagerId = 'pnpm',
  oauth: readonly OAuthProvider[] = [],
): string {
  const run = (script: string) => scriptCommand(manager, script);
  return `## Convex Auth setup

This starter uses email and password sign-in. No frontend public auth keys are needed. From the workspace root, run:

\`\`\`sh
${run('convex:setup')}
${run('convex:auth-keys')}
\`\`\`

The initial setup can push the backend before signing keys exist, but sign-in fails until JWT_PRIVATE_KEY and JWKS are set on that deployment. The key script generates an RSA 2048 key pair and uses the installed Convex CLI from packages/backend to set the PKCS8 PEM private key and public JSON Web Key Set. It never stores the key locally or prints either value. See packages/backend/.env.convex-auth.example.

Set a separate key pair for production:

\`\`\`sh
${run('convex:auth-keys')} --prod
\`\`\`

Other Convex deployment arguments can be passed after --. Each run replaces both signing values on the selected deployment. If either update fails, fix the reported problem and rerun with the same deployment flags to set a matching pair.

If you prefer to set the values yourself, follow the [manual setup procedure](https://labs.convex.dev/auth/setup/manual).

${
  oauth.length
    ? oauthSetup(scope, oauth, manager)
    : `SITE_URL is a deployment setting used for OAuth and email redirects. The official Password-only setup does not require it, and this Expo flow needs no redirect scheme. If you later add redirects, set the appropriate site origin, for example:

\`\`\`sh
${workspaceExec(manager, scope, 'backend', 'convex env set SITE_URL')} http://localhost:3000
\`\`\`

`
}

CONVEX_SITE_URL is supplied by Convex. auth.config.ts uses it as the issuer with applicationID "convex". Each frontend only needs its public Convex URL. Expo persists tokens with expo-secure-store; web apps use browser storage.

${messages ? 'Messages belong to the Convex Auth users table ID returned by getAuthUserId(ctx). Different sessions for the same account share those messages.' : 'The blank starter includes auth tables and auth functions, but no messages example. Use getAuthUserId(ctx) and enforce authorization in each protected function you add.'} Switching from Clerk changes the owner key from tokenIdentifier to the Convex Auth users table ID and requires a data migration. Provider replacement is not supported. Install Convex Auth in an existing no-auth workspace with add auth convex-auth.

Next.js, TanStack Start, and React Router use client authentication only. Server-side authentication, authenticated SSR, Next.js server providers, and auth middleware are not configured. ${oauth.length ? 'Magic links' : 'OAuth, magic links'}, email verification, password reset, and MFA are outside this starter.
`;
}

function oauthSetup(
  scope: string,
  oauth: readonly OAuthProvider[],
  manager: PackageManagerId,
): string {
  const run = (script: string) => scriptCommand(manager, script);
  return `### OAuth setup

Password sign-in remains available alongside ${oauth.map((provider) => (provider === 'github' ? 'GitHub' : 'Google')).join(' and ')}. SITE_URL is required on every Convex deployment used for OAuth. Set it to the web app that should receive completed browser sign-ins:

\`\`\`sh
${run('convex:auth-site')} http://localhost:3000
${run('convex:auth-site')} https://your-app.example --prod
\`\`\`

This script sets only SITE_URL and leaves signing keys unchanged. For a mobile-only workspace, use ccm-<project>-<app>://auth instead. Credentials belong on the Convex deployment, never in frontend environment files:

\`\`\`sh
${oauth.map((provider) => `${workspaceExec(manager, scope, 'backend', `convex env set AUTH_${provider.toUpperCase()}_ID`)} <client-id>\n${workspaceExec(manager, scope, 'backend', `convex env set AUTH_${provider.toUpperCase()}_SECRET`)} <client-secret>`).join('\n')}
\`\`\`

Create an OAuth application in each provider's developer console and register these callback URLs. Replace <CONVEX_SITE_URL> with the deployment's HTTPS .convex.site URL, not its .convex.cloud client URL:

| Provider | Callback URL |
| --- | --- |
${oauth.map((provider) => `| ${provider === 'github' ? 'GitHub' : 'Google'} | <CONVEX_SITE_URL>/api/auth/callback/${provider} |`).join('\n')}

Repeat the provider registration and deployment variables for production. Browser sign-ins must start on the SITE_URL origin, where the browser stores the sign-in verifier. To support other web origins, change the web handler to signIn(provider, { redirectTo: window.location.href }) and explicitly allow those origins in the backend redirect callback. Changing only the callback does not change the return destination.

### Expo OAuth

Use a development build, started with ${run('ios')} or ${run('android')} in the app directory. Expo Go cannot use this custom scheme. The scheme in app.json is ccm-<project>-<app>, and its return URL is ccm-<project>-<app>://auth. The backend explicitly allows each generated mobile return URL. Keep app.json, auth-controls.tsx, and the redirect callback in convex/auth.ts aligned if you change a scheme.

The provider console receives the HTTPS Convex callback above. The custom app scheme is the second redirect, from Convex back to the installed app. Register it in any native redirect allowlist the provider console requires; do not replace the HTTPS callback with it. GitHub and Google's web OAuth clients use the Convex callback. The app opens the provider URL with openAuthSessionAsync and exchanges the returned code through signIn. Cancelling closes the flow without signing in.

See [Convex Auth OAuth](https://labs.convex.dev/auth/config/oauth) and [Expo authentication](https://docs.expo.dev/guides/authentication/).
`;
}
