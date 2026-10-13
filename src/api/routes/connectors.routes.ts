import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { isConnectorCode } from '../../lib/connectorCode';
import { ChargePoint } from '../../models/ChargePoint';
import { Connector } from '../../models/Connector';
import { Transaction } from '../../models/Transaction';
import { CONNECTOR_TYPES } from '../../models/enums';
import { connectorQrUrl, mintUniqueCode } from '../../services/connector.service';
import { asyncHandler, requireAuth, requireOperator, validate } from '../middleware';

/**
 * Connector administration.
 *
 * A connector can exist before the station it belongs to has ever connected:
 * an operator registers the guns by hand so the QR stickers can be printed and
 * fitted during installation. When the station later comes online, OCPP's
 * StatusNotification upserts on (chargePointId, connectorId) and therefore
 * adopts these rows rather than duplicating them — the printed code survives.
 */
export const connectorAdminRouter = Router();
connectorAdminRouter.use(requireAuth);

const connectorInput = z.object({
  connectorId: z.number().int().min(1, 'Холбогчийн дугаар 1-ээс эхэлнэ').max(99),
  connectorType: z.enum(CONNECTOR_TYPES).optional().nullable(),
  powerKw: z.number().min(0).max(1000).optional().nullable(),
  label: z.string().trim().max(60).optional().nullable(),
});

function present(doc: Record<string, unknown> & { _id: unknown; code?: string | null }) {
  return {
    ...doc,
    id: String(doc._id),
    qrUrl: doc.code ? connectorQrUrl(doc.code) : null,
  };
}

/** Every connector on one charge point, with its sticker URL. */
connectorAdminRouter.get(
  '/charge-points/:id/connectors',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid charge point id');

    const rows = await Connector.find({ chargePointId: id })
      .sort({ connectorId: 1 })
      .lean();
    res.json({ data: rows.map(present), total: rows.length });
  }),
);

/** Register a gun by hand, before or after the station is online. */
connectorAdminRouter.post(
  '/charge-points/:id/connectors',
  requireOperator,
  validate(connectorInput),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid charge point id');

    const cp = await ChargePoint.findById(id).select('_id').lean();
    if (!cp) throw notFound('Charge point not found');

    const body = req.body as z.infer<typeof connectorInput>;
    if (await Connector.exists({ chargePointId: id, connectorId: body.connectorId })) {
      throw conflict(`Холбогч №${body.connectorId} аль хэдийн бүртгэгдсэн байна`);
    }

    const created = await Connector.create({
      chargePointId: cp._id,
      connectorId: body.connectorId,
      connectorType: body.connectorType ?? undefined,
      powerKw: body.powerKw ?? undefined,
      label: body.label?.trim() || undefined,
      code: await mintUniqueCode(),
      // Nothing has reported on it yet; say so rather than claim it is free.
      status: 'Unavailable',
    });

    await syncConnectorCount(String(cp._id));
    res.status(201).json(present(created.toObject()));
  }),
);

/** Edit the operator-set metadata. Live OCPP state is never writable here. */
connectorAdminRouter.patch(
  '/connectors/:id',
  requireOperator,
  validate(connectorInput.partial().omit({ connectorId: true })),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid connector id');

    const body = req.body as Partial<z.infer<typeof connectorInput>>;
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};

    for (const key of ['connectorType', 'powerKw', 'label'] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (value === null || value === '') $unset[key] = '';
      else $set[key] = typeof value === 'string' ? value.trim() : value;
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;

    const updated = await Connector.findByIdAndUpdate(id, update, { new: true }).lean();
    if (!updated) throw notFound('Connector not found');
    res.json(present(updated));
  }),
);

/**
 * Move a printed code onto a different connector row — the case where a gun is
 * physically replaced but its sticker stays on the charger.
 */
const reassignInput = z.object({ code: z.string().trim().toUpperCase() });

connectorAdminRouter.post(
  '/connectors/:id/code',
  requireOperator,
  validate(reassignInput),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid connector id');

    const { code } = req.body as z.infer<typeof reassignInput>;
    if (!isConnectorCode(code)) throw badRequest('Код 6 тэмдэгттэй байх ёстой');

    const target = await Connector.findById(id).lean();
    if (!target) throw notFound('Connector not found');
    if (target.connectorId <= 0) throw badRequest('Холбогч 0-д код олгохгүй');

    const holder = await Connector.findOne({ code }).lean();
    if (holder && String(holder._id) !== id) {
      throw conflict('Энэ код өөр холбогчид бүртгэлтэй байна');
    }

    const updated = await Connector.findByIdAndUpdate(
      id,
      { $set: { code } },
      { new: true },
    ).lean();
    res.json(present(updated!));
  }),
);

connectorAdminRouter.delete(
  '/connectors/:id',
  requireOperator,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid connector id');

    const connector = await Connector.findById(id).lean();
    if (!connector) throw notFound('Connector not found');

    // Deleting a connector mid-charge would orphan the session and its billing.
    const active = await Transaction.exists({
      chargePointId: connector.chargePointId,
      connectorId: connector.connectorId,
      status: 'Active',
    });
    if (active) throw conflict('Энэ холбогч дээр идэвхтэй цэнэглэлт байна');

    await Connector.deleteOne({ _id: id });
    await syncConnectorCount(String(connector.chargePointId));
    res.status(204).end();
  }),
);

/** Keeps ChargePoint.numberOfConnectors honest after a manual add or delete. */
async function syncConnectorCount(chargePointId: string): Promise<void> {
  const count = await Connector.countDocuments({
    chargePointId,
    connectorId: { $gt: 0 },
  });
  await ChargePoint.findByIdAndUpdate(chargePointId, {
    $set: { numberOfConnectors: count },
  }).catch(() => undefined);
}
