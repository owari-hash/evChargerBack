import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { notFound } from './errors';
import { ChargePoint, type ChargePointDoc } from '../models/ChargePoint';

/**
 * Charge points are identified two ways, and the difference matters.
 *
 * `_id` is a generated ObjectId. It never changes, and it is what every other
 * collection stores, so renaming a station does not touch its history.
 *
 * `cpId` is the OCPP identifier the station connects and authenticates with
 * (`CP-UB-001`). Operators can change it, and it is what people read, so it is
 * what URLs and the console show.
 *
 * Anything arriving from outside — a REST path segment, a WebSocket connect URL
 * — is one of the two, and these helpers turn it into the reference the database
 * expects.
 */

/** True when a string could be a Mongo ObjectId rather than an OCPP identifier. */
export function looksLikeObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

/**
 * Finds a charge point by either identifier. REST callers may hold an ObjectId
 * from a previous response or the OCPP identifier from a bookmark, and both
 * should keep working.
 */
export async function findChargePoint(idOrCpId: string): Promise<ChargePointDoc | null> {
  if (looksLikeObjectId(idOrCpId)) {
    const byId = await ChargePoint.findById(idOrCpId);
    if (byId) return byId;
  }
  return ChargePoint.findOne({ cpId: idOrCpId });
}

/** As `findChargePoint`, but raises the 404 the API would return anyway. */
export async function requireChargePoint(idOrCpId: string): Promise<ChargePointDoc> {
  const cp = await findChargePoint(idOrCpId);
  if (!cp) throw notFound('Charge point not found');
  return cp;
}

/**
 * The `_id` for a charge point, for querying the collections that reference it.
 * Throws the API's 404 when there is no such station.
 */
export async function requireChargePointRef(idOrCpId: string): Promise<Types.ObjectId> {
  return (await requireChargePoint(idOrCpId))._id;
}

/**
 * Resolves the OCPP identifier for each of a set of references in one query, so
 * a list endpoint can label rows without a lookup per row.
 */
export async function cpIdsFor(
  refs: Array<Types.ObjectId | string | undefined | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(refs.filter(Boolean).map((r) => String(r)))];
  if (unique.length === 0) return new Map();
  const found = await ChargePoint.find({ _id: { $in: unique } })
    .select('cpId')
    .lean();
  return new Map(found.map((cp) => [String(cp._id), cp.cpId]));
}

/**
 * The OCPP identifier for one reference, for labelling a published event or a
 * human-readable description. Returns undefined when there is no reference or
 * the station has since been deleted.
 */
export async function cpIdFor(
  ref: Types.ObjectId | string | undefined | null,
): Promise<string | undefined> {
  if (!ref) return undefined;
  const cp = await ChargePoint.findById(ref).select('cpId').lean();
  return cp?.cpId;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `resolveChargePointParam` for routes scoped to one station. */
    chargePoint?: ChargePointDoc;
  }
}

/**
 * Express `router.param` handler that turns the `:id` segment into the charge
 * point itself, so handlers can reference `req.chargePoint._id` for queries and
 * `.cpId` for the connection registry without repeating the lookup.
 */
export const resolveChargePointParam: RequestHandler<{ id?: string }> = (req, _res, next) => {
  const id = req.params.id;
  if (!id) {
    next();
    return;
  }
  findChargePoint(id)
    .then((cp) => {
      if (!cp) {
        next(notFound('Charge point not found'));
        return;
      }
      req.chargePoint = cp;
      next();
    })
    .catch(next);
};

/** The resolved charge point for the current request. */
export function chargePointOf(req: { chargePoint?: ChargePointDoc }): ChargePointDoc {
  if (!req.chargePoint) throw notFound('Charge point not found');
  return req.chargePoint;
}

/** Resolves an optional `?chargePointId=` filter value to a reference. */
export async function optionalChargePointRef(
  idOrCpId: string | undefined,
): Promise<Types.ObjectId | undefined> {
  if (!idOrCpId) return undefined;
  return requireChargePointRef(idOrCpId);
}

/** Resolves a list of identifiers, rejecting any that does not exist. */
export async function chargePointRefs(idsOrCpIds: string[]): Promise<Types.ObjectId[]> {
  return Promise.all(idsOrCpIds.map((value) => requireChargePointRef(value)));
}
