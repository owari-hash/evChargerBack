import jwt from 'jsonwebtoken';
import { sessionSecret } from '../config';

/**
 * Proof that the caller typed the SMS code sent to a phone number, carried from
 * the "enter the code" step to the "create a PIN" step. Short-lived and scoped
 * to one purpose, so a sign-up ticket cannot be replayed as a PIN reset.
 */
export type TicketPurpose = 'signup' | 'pin_reset';

export const TICKET_MINUTES = 15;

export interface PhoneTicket {
  phone: string;
  /** For a PIN reset: the account's tokenVersion, so a used ticket cannot reset twice. */
  v?: number;
}

export function issuePhoneTicket(purpose: TicketPurpose, ticket: PhoneTicket): string {
  return jwt.sign(ticket.v === undefined ? {} : { v: ticket.v }, sessionSecret(), {
    algorithm: 'HS256',
    audience: `evapp:${purpose}`,
    subject: ticket.phone,
    expiresIn: TICKET_MINUTES * 60,
  });
}

export function readPhoneTicket(purpose: TicketPurpose, token: string): PhoneTicket | null {
  try {
    const payload = jwt.verify(token, sessionSecret(), {
      algorithms: ['HS256'],
      audience: `evapp:${purpose}`,
    });
    if (typeof payload === 'string' || !payload.sub) return null;
    const v = (payload as { v?: unknown }).v;
    return { phone: payload.sub, v: typeof v === 'number' ? v : undefined };
  } catch {
    return null;
  }
}
