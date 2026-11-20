import type { Types } from 'mongoose';
import { PowerAlert } from '../models/PowerAlert';
import { Transaction } from '../models/Transaction';
import { bus } from '../realtime/events';
import { describeStationFault, meaningfulVendorCode } from '../driver/station-faults';

/** Sessions on one gun failing with the same vendor fault this often point to hardware. */
export const REPEATED_FAULT_THRESHOLD = 3;
export const REPEATED_FAULT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Called after a station error is stored on a session. When the same gun has
 * now reported the same vendor fault on REPEATED_FAULT_THRESHOLD or more
 * sessions within the window, raises (or refreshes) one operator alert for
 * that gun and code.
 */
export async function checkRepeatedStationFault(input: {
  chargePointId: Types.ObjectId;
  cpId: string;
  connectorId: number;
  errorCode?: string | null;
  vendorErrorCode?: string | null;
  at: Date;
}): Promise<void> {
  const code = meaningfulVendorCode(input.vendorErrorCode);
  if (!code || input.connectorId <= 0) return;

  const since = new Date(input.at.getTime() - REPEATED_FAULT_WINDOW_MS);
  const txs = await Transaction.find({
    chargePointId: input.chargePointId,
    connectorId: input.connectorId,
    'stationError.vendorErrorCode': code,
    'stationError.at': { $gte: since },
  })
    .select('_id')
    .sort({ 'stationError.at': -1 })
    .limit(20)
    .lean();
  if (txs.length < REPEATED_FAULT_THRESHOLD) return;

  const fault = describeStationFault(input.errorCode, code);
  const gun = input.connectorId <= 26 ? String.fromCharCode(64 + input.connectorId) : String(input.connectorId);
  const measuredValues = {
    vendorErrorCode: code,
    errorCode: input.errorCode ?? '',
    faultKind: fault?.kind ?? 'station_fault',
    sessions24h: txs.length,
    transactionIds: txs.map((t) => t._id),
  };

  const existing = await PowerAlert.findOne({
    cpId: input.cpId,
    connectorId: input.connectorId,
    alertType: 'REPEATED_STATION_FAULT',
    'measuredValues.vendorErrorCode': code,
    status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] },
  });
  if (existing) {
    existing.lastSeenAt = input.at;
    existing.measuredValues = measuredValues;
    existing.message = message(gun, code, txs.length, fault?.mn.title);
    await existing.save();
    return;
  }

  const alert = await PowerAlert.create({
    chargePointId: input.chargePointId,
    cpId: input.cpId,
    connectorId: input.connectorId,
    alertType: 'REPEATED_STATION_FAULT',
    severity: fault && !fault.vehicleSide ? 'CRITICAL' : 'WARNING',
    title: `Буу ${gun}: ${code} давтагдаж байна`,
    message: message(gun, code, txs.length, fault?.mn.title),
    status: 'ACTIVE',
    firstSeenAt: input.at,
    lastSeenAt: input.at,
    measuredValues,
  });
  bus.emitEvent('power.alert', input.cpId, alert.toJSON());
}

function message(gun: string, code: string, n: number, title?: string): string {
  return (
    `Сүүлийн 24 цагт буу ${gun} дээр ${n} цэнэглэлт "${code}"${title ? ` (${title})` : ''} алдаатай тасарсан. ` +
    'Олон өөр машин дээр давтагдаж байвал станцын тоног төхөөрөмжийг шалгана уу.'
  );
}
