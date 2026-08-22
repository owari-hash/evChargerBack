import type { z } from 'zod';
import { ocppLogger } from '../../lib/logger';
import { Certificate, CsrRequest } from '../../models/Security';
import { recordSecurityEvent } from '../../services/security.service';
import { signCsr } from '../../services/ca.service';
import type * as security from '../schemas/security';
import type { ChargePointConnection } from '../connection';

type Req<T extends z.ZodTypeAny> = z.output<T>;

/** White paper 5.15 — SecurityEventNotification.req */
export async function onSecurityEventNotification(
  payload: Req<typeof security.SecurityEventNotificationReq>,
  conn: ChargePointConnection,
) {
  await recordSecurityEvent(
    conn.cpId,
    payload.type,
    payload.techInfo,
    'ChargePoint',
    payload.timestamp,
  );
  return {};
}

/**
 * White paper 5.17 — SignCertificate.req (use cases A02 / A03).
 *
 * A02.FR.11: respond Accepted as soon as the CSR is accepted for processing.
 * The signed certificate is then pushed back with CertificateSigned.req, which
 * we do asynchronously so the .conf is not held up by the CA round trip.
 */
export async function onSignCertificate(
  payload: Req<typeof security.SignCertificateReq>,
  conn: ChargePointConnection,
) {
  const record = await CsrRequest.create({
    chargePointId: conn.ref,
    csrPem: payload.csr,
    status: 'Pending',
  });

  setImmediate(() => {
    void processCsr(String(record._id), conn);
  });

  return { status: 'Accepted' as const };
}

async function processCsr(csrId: string, conn: ChargePointConnection): Promise<void> {
  const record = await CsrRequest.findById(csrId);
  if (!record) return;

  try {
    const signed = signCsr(record.csrPem, conn.cpId);

    record.certificatePem = signed.certificatePem;
    record.subject = signed.subject;
    record.status = 'Signed';
    await record.save();

    await Certificate.create({
      chargePointId: conn.ref,
      type: 'ChargePointCertificate',
      pem: signed.certificatePem,
      serialNumber: signed.serialNumber,
      subject: signed.subject,
      issuer: signed.issuer,
      validFrom: signed.validFrom,
      validTo: signed.validTo,
    });

    // A02.FR.09 — deliver the signed certificate (leaf + sub CA chain).
    const res = await conn.call<{ status: string }>(
      'CertificateSigned',
      { certificateChain: signed.chainPem },
      'system:SignCertificate',
    );

    record.status = res.status === 'Accepted' ? 'Delivered' : 'Failed';
    record.failureReason = res.status === 'Accepted' ? undefined : 'Charge point rejected the certificate';
    record.deliveredAt = res.status === 'Accepted' ? new Date() : undefined;
    await record.save();

    if (res.status !== 'Accepted') {
      await recordSecurityEvent(
        conn.cpId,
        'InvalidChargePointCertificate',
        'CertificateSigned.req was rejected by the charge point',
        'CentralSystem',
      );
    }
  } catch (err) {
    ocppLogger.error({ err, cp: conn.cpId }, 'failed to process CSR');
    record.status = 'Failed';
    record.failureReason = (err as Error).message;
    await record.save().catch(() => undefined);
    await recordSecurityEvent(
      conn.cpId,
      'InvalidChargePointCertificate',
      `CSR processing failed: ${(err as Error).message}`,
      'CentralSystem',
    );
  }
}
