export interface Config {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly adminApiToken: string | undefined;
  /** Registers the test payment provider, which moves no money (ADR 0019). Off unless set. */
  readonly enableTestPaymentProvider: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const port = Number(env.PORT ?? 9000);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT "${env.PORT}"`);
  return {
    databaseUrl,
    host: env.HOST ?? '0.0.0.0',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    adminApiToken: env.ADMIN_API_TOKEN || undefined,
    enableTestPaymentProvider: flag(env, 'ENABLE_TEST_PAYMENT_PROVIDER'),
  };
}

/** `true` or `false`; unset means false. Anything else is a mistake worth stopping for. */
function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be "true" or "false", not "${env[name]}"`);
}
