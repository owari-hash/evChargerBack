import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { env } from '../../config/env';
import { requireChargePoint, requireChargePointRef } from '../../lib/chargePointRef';
import { notFound, badRequest } from '../../lib/errors';
import { Certificate, CsrRequest, SecurityEvent } from '../../models/Security';
import { CERTIFICATE_TYPES } from '../../models/enums';
import { generateCa, parseCertificate, signCsr } from '../../services/ca.service';
import { connectionManager } from '../../ocpp/manager';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAdmin,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

export const securityRouter = Router();
securityRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Security events (white paper section 8)
// ---------------------------------------------------------------------------

const eventQuery = paginationSchema.extend({
  chargePointId: z.string().optional(),
  type: z.string().optional(),
  critical: z.enum(['true', 'false']).optional(),
  acknowledged: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

securityRouter.get(
  '/events',
  validate(eventQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof eventQuery>;
    const filter: Record<string, unknown> = {};
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.type) filter.type = q.type;
    if (q.critical) filter.isCritical = q.critical === 'true';
    if (q.acknowledged) filter.acknowledged = q.acknowledged === 'true';
    if (q.from || q.to) {
      filter.timestamp = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    }

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      SecurityEvent.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      SecurityEvent.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

securityRouter.post(
  '/events/:id/acknowledge',
  requireOperator,
  asyncHandler(async (req, res) => {
    const doc = await SecurityEvent.findByIdAndUpdate(
      req.params.id,
      { $set: { acknowledged: true, acknowledgedBy: req.user?.email, acknowledgedAt: new Date() } },
      { new: true },
    );
    if (!doc) throw notFound('Security event not found');
    res.json(doc.toJSON());
  }),
);

securityRouter.get(
  '/events/summary',
  asyncHandler(async (_req, res) => {
    const byType = await SecurityEvent.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 }, lastAt: { $max: '$timestamp' } } },
      { $sort: { count: -1 } },
    ]);
    const unacknowledgedCritical = await SecurityEvent.countDocuments({
      isCritical: true,
      acknowledged: false,
    });
    res.json({ byType, unacknowledgedCritical });
  }),
);

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

const certQuery = paginationSchema.extend({
  chargePointId: z.string().optional(),
  type: z.enum(CERTIFICATE_TYPES).optional(),
});

securityRouter.get(
  '/certificates',
  validate(certQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof certQuery>;
    const filter: Record<string, unknown> = { deletedAt: null };
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.type) filter.type = q.type;

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      Certificate.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Certificate.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

/** Compute CertificateHashDataType for an arbitrary PEM (handy for DeleteCertificate). */
const inspectSchema = z.object({ certificate: z.string().min(1) });

securityRouter.post(
  '/certificates/inspect',
  validate(inspectSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof inspectSchema>;
    res.json(parseCertificate(body.certificate));
  }),
);

// ---------------------------------------------------------------------------
// Local CA
// ---------------------------------------------------------------------------

securityRouter.get(
  '/ca',
  asyncHandler(async (_req, res) => {
    if (!existsSync(env.CSMS_CA_CERT_PATH)) {
      res.json({ present: false, certPath: env.CSMS_CA_CERT_PATH });
      return;
    }
    const pem = readFileSync(env.CSMS_CA_CERT_PATH, 'utf8');
    res.json({ present: true, certPath: env.CSMS_CA_CERT_PATH, pem, ...parseCertificate(pem) });
  }),
);

const generateCaSchema = z.object({
  commonName: z.string().default('CSMS Root CA'),
  years: z.number().int().min(1).max(30).default(10),
  force: z.boolean().default(false),
});

securityRouter.post(
  '/ca/generate',
  requireAdmin,
  validate(generateCaSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof generateCaSchema>;
    if (existsSync(env.CSMS_CA_CERT_PATH) && !body.force) {
      throw badRequest('A CA already exists. Pass force:true to overwrite it.');
    }
    const { certPem } = generateCa(body.commonName, body.years);
    res.status(201).json({ pem: certPem, ...parseCertificate(certPem) });
  }),
);

// ---------------------------------------------------------------------------
// CSRs (SignCertificate flow)
// ---------------------------------------------------------------------------

const csrQuery = paginationSchema.extend({
  chargePointId: z.string().optional(),
  status: z.enum(['Pending', 'Signed', 'Rejected', 'Delivered', 'Failed']).optional(),
});

securityRouter.get(
  '/csrs',
  validate(csrQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof csrQuery>;
    const filter: Record<string, unknown> = {};
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.status) filter.status = q.status;

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      CsrRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CsrRequest.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

/** Re-sign a CSR and push the result with CertificateSigned.req. */
securityRouter.post(
  '/csrs/:id/sign',
  requireOperator,
  asyncHandler(async (req, res) => {
    const record = await CsrRequest.findById(req.params.id);
    if (!record) throw notFound('CSR not found');

    // The certificate's common name is the identity the station presents.
    const cp = await requireChargePoint(String(record.chargePointId));
    const signed = signCsr(record.csrPem, cp.cpId);
    record.certificatePem = signed.certificatePem;
    record.subject = signed.subject;
    record.status = 'Signed';
    await record.save();

    await Certificate.create({
      chargePointId: record.chargePointId,
      type: 'ChargePointCertificate',
      pem: signed.certificatePem,
      serialNumber: signed.serialNumber,
      subject: signed.subject,
      issuer: signed.issuer,
      validFrom: signed.validFrom,
      validTo: signed.validTo,
    });

    let delivery: unknown = null;
    if (connectionManager.isOnline(cp.cpId)) {
      delivery = await connectionManager
        .send(
          cp.cpId,
          'CertificateSigned',
          { certificateChain: signed.chainPem },
          req.user?.email,
        )
        .catch((err: Error) => ({ error: err.message }));

      if ((delivery as { status?: string })?.status === 'Accepted') {
        record.status = 'Delivered';
        record.deliveredAt = new Date();
        await record.save();
      }
    }

    res.json({ csr: record.toJSON(), certificate: signed.certificatePem, delivery });
  }),
);

securityRouter.post(
  '/csrs/:id/reject',
  requireOperator,
  asyncHandler(async (req, res) => {
    const record = await CsrRequest.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: 'Rejected',
          failureReason: typeof req.body?.reason === 'string' ? req.body.reason : 'Rejected by operator',
        },
      },
      { new: true },
    );
    if (!record) throw notFound('CSR not found');
    res.json(record.toJSON());
  }),
);
