import { env } from '../../config/env';
import { driverLogger } from '../http';
import type { DeliveryResult } from './email';

export interface SmsMessage {
  to: string;
  text: string;
}

function sendViaConsole(message: SmsMessage): DeliveryResult {
  // eslint-disable-next-line no-console
  console.info(`\n=== SMS (console provider) ${new Date().toISOString()} ===\nTo: ${message.to}\n\n${message.text}\n`);
  driverLogger.warn(
    { to: message.to },
    'SMS_PROVIDER is "console" — SMS was printed to console only, not sent to carrier. Set SMS_PROVIDER=callpro in .env for real delivery.',
  );
  return { delivered: true, provider: 'console' };
}

/**
 * Generic HTTP gateway — covers most local SMS providers.
 *
 *   SMS_HTTP_URL=https://api.provider.mn/send?to={to}&text={text}&key=xxx
 *   SMS_HTTP_METHOD=GET
 *
 * or with a JSON body:
 *
 *   SMS_HTTP_URL=https://api.provider.mn/send
 *   SMS_HTTP_METHOD=POST
 *   SMS_HTTP_BODY={"to":"{to}","message":"{text}","from":"{from}"}
 *   SMS_HTTP_HEADERS={"Authorization":"Bearer xxx"}
 */
async function sendViaHttp(message: SmsMessage): Promise<DeliveryResult> {
  if (!env.SMS_HTTP_URL) return { delivered: false, provider: 'http', error: 'SMS_HTTP_URL is not set' };

  const fill = (template: string, encode: boolean) => {
    const value = (v: string) => (encode ? encodeURIComponent(v) : v);
    return template
      .replaceAll('{to}', value(message.to))
      .replaceAll('{text}', value(message.text))
      .replaceAll('{from}', value(env.SMS_FROM));
  };

  const method = env.SMS_HTTP_METHOD.toUpperCase();
  const headers: Record<string, string> = env.SMS_HTTP_HEADERS ? JSON.parse(env.SMS_HTTP_HEADERS) : {};
  let body: string | undefined;
  if (method !== 'GET' && env.SMS_HTTP_BODY) {
    headers['Content-Type'] ??= 'application/json';
    body = fill(env.SMS_HTTP_BODY, false);
  }

  const res = await fetch(fill(env.SMS_HTTP_URL, true), { method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    return { delivered: false, provider: 'http', error: `${res.status} ${text.slice(0, 200)}` };
  }
  return { delivered: true, provider: 'http', id: text.slice(0, 120) };
}

async function sendViaTwilio(message: SmsMessage): Promise<DeliveryResult> {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
  if (!sid || !token || !from) {
    return { delivered: false, provider: 'twilio', error: 'Twilio credentials are incomplete' };
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: message.to, From: from, Body: message.text }),
  });

  const json = (await res.json()) as { sid?: string; message?: string };
  if (!res.ok) {
    return { delivered: false, provider: 'twilio', error: json.message ?? `HTTP ${res.status}` };
  }
  return { delivered: true, provider: 'twilio', id: json.sid };
}

/** CallPro Text v1 API (POST JSON with x-api-key). */
async function sendViaCallpro(
  message: SmsMessage,
  provider: 'callpro' | 'messagepro',
): Promise<DeliveryResult> {
  const key = env.CALLPRO_SMS_KEY || env.MESSAGEPRO_SMS_KEY;
  if (!key) {
    const err = 'Neither CALLPRO_SMS_KEY nor MESSAGEPRO_SMS_KEY is configured in .env';
    driverLogger.error({ provider }, err);
    return { delivered: false, provider, error: err };
  }

  // Remove leading '+' from phone number for telecom gateway compatibility
  const to = message.to.replace(/^\+/, '');
  const url = env.CALLPRO_SMS_URL || 'https://api-text.callpro.mn/v1/sms/send';

  driverLogger.info({ provider, url, from: env.SMS_FROM, to }, 'Sending SMS via CallPro');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify({
      from: env.SMS_FROM,
      to,
      text: message.text,
    }),
  });

  const text = await res.text();
  driverLogger.info({ provider, status: res.status, body: text.slice(0, 300) }, 'CallPro SMS response');

  if (!res.ok) {
    driverLogger.error({ provider, status: res.status, error: text }, 'CallPro delivery failed');
    return { delivered: false, provider, error: `${res.status} ${text.slice(0, 200)}` };
  }
  return { delivered: true, provider, id: text.slice(0, 120) };
}

export async function sendSms(message: SmsMessage): Promise<DeliveryResult> {
  const provider = env.SMS_PROVIDER.toLowerCase();
  driverLogger.info({ provider, to: message.to }, 'sendSms requested');
  try {
    switch (provider) {
      case 'callpro':
      case 'messagepro':
        return await sendViaCallpro(message, provider);
      case 'http':
        return await sendViaHttp(message);
      case 'twilio':
        return await sendViaTwilio(message);
      case 'console':
      case '':
        return sendViaConsole(message);
      default:
        driverLogger.error({ provider }, `Unknown SMS_PROVIDER "${provider}"`);
        return { delivered: false, provider, error: `Unknown SMS_PROVIDER "${provider}"` };
    }
  } catch (err) {
    driverLogger.error({ err }, 'sms delivery failed');
    return { delivered: false, provider, error: (err as Error).message };
  }
}
