export function convexAuthSetup(scope: string, messages: boolean): string {
  return `## Convex Auth setup

This starter uses email and password sign-in. No frontend public auth keys are needed. From the workspace root, run:

\`\`\`sh
pnpm convex:setup
pnpm convex:auth-keys
\`\`\`

The initial setup can push the backend before signing keys exist, but sign-in fails until JWT_PRIVATE_KEY and JWKS are set on that deployment. The key script generates an RSA 2048 key pair and uses the installed Convex CLI from packages/backend to set the PKCS8 PEM private key and public JSON Web Key Set. It never stores the key locally or prints either value. See packages/backend/.env.convex-auth.example.

Set a separate key pair for production:

\`\`\`sh
pnpm convex:auth-keys --prod
\`\`\`

Other Convex deployment arguments can be passed after --. Each run replaces both signing values on the selected deployment. If either update fails, fix the reported problem and rerun with the same deployment flags to set a matching pair.

If you prefer to set the values yourself, follow the [manual setup procedure](https://labs.convex.dev/auth/setup/manual).

SITE_URL is a deployment setting used for OAuth and email redirects. The official Password-only setup does not require it, and this Expo flow needs no redirect scheme. If you later add redirects, set the appropriate site origin, for example:

\`\`\`sh
pnpm --filter @${scope}/backend exec convex env set SITE_URL http://localhost:3000
\`\`\`

CONVEX_SITE_URL is supplied by Convex. auth.config.ts uses it as the issuer with applicationID "convex". Each frontend only needs its public Convex URL. Expo persists tokens with expo-secure-store; web apps use browser storage.

${messages ? 'Messages belong to the Convex Auth users table ID returned by getAuthUserId(ctx). Different sessions for the same account share those messages.' : 'The blank starter includes auth tables and auth functions, but no messages example. Use getAuthUserId(ctx) and enforce authorization in each protected function you add.'} Switching from Clerk changes the owner key from tokenIdentifier to the Convex Auth users table ID and requires a data migration. Provider replacement and add auth convex-auth are not supported yet.

Next.js and TanStack Start use client authentication only. Server-side authentication, authenticated SSR, Next.js server providers, and auth middleware are not configured. OAuth, magic links, email verification, password reset, and MFA are outside this starter.
`;
}
