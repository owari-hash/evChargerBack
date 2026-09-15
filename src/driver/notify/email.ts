import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import { env } from '../../config/env';
import { driverLogger } from '../http';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface DeliveryResult {
  delivered: boolean;
  provider: string;
  id?: string;
  error?: string;
}

/**
 * Prints the message instead of sending it. The default, so the API runs with
 * no mail credentials configured.
 */
function sendViaConsole(message: EmailMessage): DeliveryResult {
  // eslint-disable-next-line no-console
  console.info(
    `\n=== EMAIL ${new Date().toISOString()} ===\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`,
  );
  return { delivered: true, provider: 'console' };
}

let cachedTransport: { key: string; transport: Transporter } | null = null;

async function sendViaSmtp(message: EmailMessage): Promise<DeliveryResult> {
  if (!env.SMTP_HOST) {
    return { delivered: false, provider: 'smtp', error: 'SMTP_HOST is not configured' };
  }

  const key = [
    env.SMTP_HOST,
    env.SMTP_PORT,
    env.SMTP_USER,
    env.SMTP_SECURE,
    env.SMTP_REJECT_UNAUTHORIZED,
    env.SMTP_POOL,
  ].join(':');

  if (!cachedTransport || cachedTransport.key !== key) {
    cachedTransport = {
      key,
      transport: nodemailer.createTransport({
        pool: env.SMTP_POOL,
        maxConnections: 5,
        maxMessages: 100,
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        tls: { rejectUnauthorized: env.SMTP_REJECT_UNAUTHORIZED },
      } as SMTPPool.Options),
    };
  }

  const info = await cachedTransport.transport.sendMail({
    from: env.EMAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  return { delivered: true, provider: 'smtp', id: info.messageId };
}

export async function sendEmail(message: EmailMessage): Promise<DeliveryResult> {
  const provider = env.EMAIL_PROVIDER.toLowerCase();
  try {
    switch (provider) {
      case 'smtp':
        return await sendViaSmtp(message);
      case 'console':
      case '':
        return sendViaConsole(message);
      default:
        return { delivered: false, provider, error: `Unknown EMAIL_PROVIDER "${provider}"` };
    }
  } catch (err) {
    driverLogger.error({ err }, 'email delivery failed');
    return { delivered: false, provider, error: (err as Error).message };
  }
}
