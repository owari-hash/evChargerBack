import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HTTP_PORT: int(3000),
  HTTP_HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGIN: z.string().default('*'),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/csms'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().default('ChangeMe123!'),
  API_KEY: z.string().optional(),

  OCPP_PATH_PREFIX: z.string().default('/ocpp'),
  OCPP_SECURITY_PROFILE: int(1).pipe(z.number().int().min(1).max(3)),
  OCPP_REQUIRE_KNOWN_CHARGEPOINT: bool(false),
  OCPP_ALLOW_ANONYMOUS: bool(true),
  OCPP_HEARTBEAT_INTERVAL: int(300),
  OCPP_CALL_TIMEOUT_MS: int(30_000),
  OCPP_PING_INTERVAL_MS: int(30_000),
  OCPP_LOG_MESSAGES: bool(true),
  OCPP_LOG_RETENTION_DAYS: int(30),

  TLS_ENABLED: bool(false),
  TLS_KEY_PATH: z.string().default('./certs/server.key'),
  TLS_CERT_PATH: z.string().default('./certs/server.crt'),
  TLS_CA_PATH: z.string().default('./certs/ca.crt'),

  CSMS_CA_KEY_PATH: z.string().default('./certs/ca.key'),
  CSMS_CA_CERT_PATH: z.string().default('./certs/ca.crt'),
  CSMS_CERT_VALIDITY_DAYS: int(365),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
