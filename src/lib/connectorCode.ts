import { randomInt } from 'node:crypto';

/**
 * The short permanent code printed on a connector's QR sticker.
 *
 * It is minted once, stored on the Connector, and never regenerated: stickers
 * are physical objects on a charger in the field, so the code outlives station
 * renames, firmware swaps and anything an operator does in the console. In
 * particular it is deliberately NOT derived from `cpId`, which the schema says
 * an operator may change.
 *
 * The alphabet drops every glyph that gets misread off a scratched sticker or
 * misheard over the phone to support: 0/O, 1/I/L, and U (which handwrites as V).
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 6;

/** 30^6 ≈ 729 million, so collisions stay rare enough that one retry is plenty. */
export function generateConnectorCode(): string {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const PATTERN = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

export function isConnectorCode(value: unknown): value is string {
  return typeof value === 'string' && PATTERN.test(value);
}

/**
 * Accepts what a driver might actually type — lower case, stray spaces or
 * hyphens — and returns null for anything else.
 *
 * It deliberately does NOT guess at lookalikes. Every ambiguous glyph is absent
 * from the alphabet, so a code containing one was misread, and there is no safe
 * single substitution: mapping it could silently resolve to a different, real
 * connector and start a charge on the wrong gun. Failing is the correct answer.
 */
export function normalizeConnectorCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return PATTERN.test(cleaned) ? cleaned : null;
}
