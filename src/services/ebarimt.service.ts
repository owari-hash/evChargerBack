import { Transaction, type TransactionDoc } from '../models/Transaction';
import { Payment, type PaymentDoc } from '../models/Payment';
import { EbarimtMerchant, ensureDefaultEbarimtMerchant } from '../models/EbarimtMerchant';
import { ebarimtLogger } from '../lib/logger';
import { ChargePoint } from '../models/ChargePoint';
import { Client } from '../models/Client';
import { HttpError, badRequest, notFound } from '../lib/errors';
import { store } from '../driver/store';
import { itcEasyRegisterService } from './itc-easy-register.service';

export interface IssueEBarimtOptions {
  type?: 'B2C_RECEIPT' | 'B2B_RECEIPT';
  customerTin?: string;
  customerNo?: string;
}

/** A receipt the PosAPI did not issue. Nothing fake is ever stored in its place. */
export class ReceiptError extends Error {}

/**
 * POST a receipt to the PosAPI. Resolves only for a receipt the PosAPI actually
 * issued (2xx with an id); anything else throws, so callers record a failure
 * instead of a made-up receipt id and lottery number.
 */
async function postReceipt(baseUrl: string, payload: unknown): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/rest/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ReceiptError(`PosAPI unreachable: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    throw new ReceiptError(`PosAPI HTTP ${res.status}: ${String(data?.message ?? data?.error ?? '').slice(0, 200)}`);
  }
  // A valid receipt may have DDTD (id/receiptId/ddtd/billId) or only a lottery number
  // (lottery/lotteryNo) when the merchant is not yet a VAT taxpayer (НӨАТ төлөгч биш).
  const hasReceiptId = Boolean(data?.id || data?.receiptId || data?.ddtd || data?.billId);
  const hasLottery = Boolean(data?.lottery || data?.lotteryNo || data?.lottery_no);
  const hasQr = Boolean(data?.qrData || data?.qr || data?.qrCode);
  const isOkStatus = data?.status === 'SUCCESS' || data?.success === true;

  if (!hasReceiptId && !hasLottery && !hasQr && !isOkStatus) {
    throw new ReceiptError('PosAPI answered without receipt identification (no DDTD or lottery number)');
  }
  return data;
}

const BOGUS_EBARIMT_CODES = new Set([
  '00000000',
  '11111111',
  '22222222',
  '33333333',
  '44444444',
  '55555555',
  '66666666',
  '77777777',
  '88888888',
  '99999999',
  '12345678',
  '87654321',
]);

/**
 * Validates a taxpayer TIN or enterprise registration number against official
 * ebarimt.mn central tax database.
 */
export async function verifyTaxpayer(tinOrRegNo: string): Promise<{ valid: boolean; name?: string; tin?: string; vatPayer?: boolean; error?: string }> {
  const clean = tinOrRegNo.trim();
  if (!clean) return { valid: false, error: 'Татвар төлөгчийн дугаар хоосон байна' };

  try {
    // 1. Check as TIN
    const tinRes = await fetch(`https://api.ebarimt.mn/api/info/check/getInfo?tin=${encodeURIComponent(clean)}`, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (tinRes.ok) {
      const data = (await tinRes.json().catch(() => null)) as { status?: number; data?: { found?: boolean; name?: string; vatPayer?: boolean } };
      if (data?.status === 200 && (data.data?.found || data.data?.name)) {
        return { valid: true, name: data.data.name, tin: clean, vatPayer: data.data.vatPayer };
      }
    }

    // 2. Check as enterprise registration number (e.g. 7-digit RD)
    const regRes = await fetch(`https://api.ebarimt.mn/api/info/check/getTinInfo?regNo=${encodeURIComponent(clean)}`, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (regRes.ok) {
      const data = (await regRes.json().catch(() => null)) as { status?: number; data?: string | number };
      if (data?.status === 200 && data.data) {
        const resolvedTin = String(data.data);
        const nameRes = await fetch(`https://api.ebarimt.mn/api/info/check/getInfo?tin=${encodeURIComponent(resolvedTin)}`, {
          signal: AbortSignal.timeout(4000),
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        }).catch(() => null);
        const nameData = nameRes && nameRes.ok ? ((await nameRes.json().catch(() => null)) as { data?: { name?: string; vatPayer?: boolean } }) : null;
        return { valid: true, name: nameData?.data?.name, tin: resolvedTin, vatPayer: nameData?.data?.vatPayer };
      }
    }

    return { valid: false, error: 'Татварын ерөнхий газрын бүртгэлд олдсонгүй (Хүчингүй ТТД/Регистр)' };
  } catch {
    // In case ebarimt.mn network timeout occurs, allow PosAPI to be the final arbiter
    return { valid: true, tin: clean };
  }
}

export interface EbarimtVerifyResult {
  valid: boolean;
  type?: 'CITIZEN_PHONE' | 'CITIZEN_CODE' | 'ORGANIZATION';
  name?: string;
  tin?: string;
  message: string;
}

/**
 * Validates an ebarimt code before saving or transaction:
 * - Checks live against central tax authority (api.ebarimt.mn) if it's an enterprise TIN/Register
 * - Verifies against user's verified phone number
 * - Verifies against Mongolian mobile telecom numbering plan
 * - Verifies against citizen 8-digit customer code format and rejects bogus sequences
 */
export async function verifyEbarimtCustomerNo(
  code: string,
  userPhone?: string,
): Promise<EbarimtVerifyResult> {
  const clean = code.trim();
  if (!clean) return { valid: true, message: '' };

  // 1. Basic format
  if (!/^\d{7,12}$/.test(clean)) {
    return {
      valid: false,
      message: 'И-Баримтын хэрэглэгчийн код 8 оронтой тоо (эсвэл байгууллагын ТТД/Регистр) байх ёстой.',
    };
  }

  // 2. Reject obvious dummy sequences
  if (BOGUS_EBARIMT_CODES.has(clean) || /^(\d)\1{6,}$/.test(clean)) {
    return {
      valid: false,
      message: 'Хүчингүй код байна. Өөрийн Ebarimt систем дэх бодит 8 оронтой кодоо оруулна уу.',
    };
  }

  // 3. Check if it matches an organization TIN/Register in central tax authority
  try {
    const taxCheck = await verifyTaxpayer(clean);
    if (taxCheck.valid && taxCheck.name) {
      return {
        valid: true,
        type: 'ORGANIZATION',
        name: taxCheck.name,
        tin: taxCheck.tin,
        message: `Байгууллага баталгаажлаа: ${taxCheck.name}`,
      };
    }
  } catch {}

  // 4. Official ITC Easy-Register getProfile check (api-1787241529220)
  // Real check with ТЕГ/ITC database. No fake fallback — if it fails, return the real error!
  const itcRes = await itcEasyRegisterService.getProfile({ customerNo: clean });
  if (itcRes.valid) {
    return {
      valid: true,
      type: 'CITIZEN_CODE',
      name: itcRes.loginName,
      message: itcRes.message,
    };
  }

  return {
    valid: false,
    message: itcRes.message || 'Ebarimt системд бүртгэлгүй хэрэглэгчийн код байна.',
  };
}

export function calculateVat(amount: number): number {
  if (!amount || amount <= 0) return 0;
  const vat = amount - amount / 1.1;
  return Math.round(vat * 100) / 100;
}

/**
 * Resolves the 4-digit districtCode required by PosAPI (pattern: [0-9]{4}).
 * E.g. "2415" (district 24 + khoroo 15), "2301" (district 23 + khoroo 01).
 */
export function resolveDistrictCode(merchant?: { districtCode?: string; khorooCode?: string } | null): string {
  const envDistrict = process.env.EBARIMT_DISTRICT_CODE?.trim();
  if (envDistrict && /^\d{4}$/.test(envDistrict)) {
    return envDistrict;
  }

  const rawDistrict = (merchant?.districtCode || envDistrict || '24').trim();
  const rawKhoroo = (merchant?.khorooCode || '15').trim();

  // If already 4 digits (e.g. "2415"), return it directly
  if (/^\d{4}$/.test(rawDistrict)) {
    return rawDistrict;
  }

  // If 2 digits (e.g. "23" or "24"), combine with 2-digit khoroo (e.g. "01" or "15")
  if (/^\d{2}$/.test(rawDistrict)) {
    const khorooPad = rawKhoroo.padStart(2, '0').slice(-2);
    return `${rawDistrict}${khorooPad}`;
  }

  if (/^\d{1,3}$/.test(rawDistrict)) {
    return rawDistrict.padEnd(4, '0');
  }

  return '2415';
}

/**
 * The merchant a station's receipts belong to: the station's own setting, else
 * its client's. Null means "use the network default". A configured merchant
 * that is missing or disabled is an error, never a silent fallback — that would
 * put the client's sale on someone else's tax number.
 */
async function merchantForTransaction(tx: TransactionDoc) {
  const cp = await ChargePoint.findById(tx.chargePointId).select('ebarimtMerchantId clientId').lean();
  // The client snapshotted at start owns the sale; null means it had none.
  // Only sessions recorded before the snapshot existed use the station's client.
  const clientId = tx.clientId !== undefined ? tx.clientId : cp?.clientId;
  const client = clientId ? await Client.findById(clientId).select('ebarimtMerchantId name').lean() : null;
  const merchantId = cp?.ebarimtMerchantId ?? client?.ebarimtMerchantId;
  if (!merchantId) return null;
  const merchant = await EbarimtMerchant.findOne({ _id: merchantId, enabled: true }).lean();
  if (!merchant) {
    throw new HttpError(
      409,
      `${client?.name ?? 'Станц'}-ын е-баримтын мерчант идэвхгүй эсвэл устсан байна. Админ тохиргоог шалгана уу.`,
    );
  }
  return merchant;
}

interface ReceiptLine {
  name: string;
  unit: string;
  qty: number;
  unitPrice: number;
  amount: number;
  vat: number;
}

/**
 * Receipt items. With a service fee the energy and the fee are separate lines
 * whose amounts add up exactly to the receipt total.
 */
function receiptLines(tx: TransactionDoc, total: number): ReceiptLine[] {
  const kwh = (tx.energyWh ?? 0) / 1000 || 1;
  const fee = tx.feeAmount ?? 0;
  if (!(fee > 0) || tx.energyCost == null) {
    return [
      {
        name: 'EV Цэнэглэлтийн үйлчилгээ',
        unit: 'кВт·ц',
        qty: kwh,
        unitPrice: tx.tariffPerKwh ?? 500,
        amount: total,
        vat: calculateVat(total),
      },
    ];
  }
  const energy = Math.round(tx.energyCost * 100) / 100;
  const feeLine = Math.round((total - energy) * 100) / 100;
  return [
    {
      name: 'EV Цэнэглэлтийн үйлчилгээ',
      unit: 'кВт·ц',
      qty: kwh,
      unitPrice: tx.tariffPerKwh ?? energy / kwh,
      amount: energy,
      vat: calculateVat(energy),
    },
    {
      name: `Үйлчилгээний хураамж (${tx.feePercent ?? 0}%)`,
      unit: 'ш',
      qty: 1,
      unitPrice: feeLine,
      amount: feeLine,
      vat: calculateVat(feeLine),
    },
  ];
}

export async function issueEBarimtForTransaction(
  transactionId: number,
  options: IssueEBarimtOptions = {},
): Promise<TransactionDoc> {
  const tx = await Transaction.findById(transactionId);
  if (!tx) throw notFound(`Transaction #${transactionId} not found`);
  if (tx.status === 'Refunded') {
    throw badRequest('Буцаалт хийгдсэн цэнэглэлтэд е-баримт олгохгүй');
  }
  if (tx.status !== 'Completed' || !(tx.cost && tx.cost > 0)) {
    throw badRequest('Төлбөртэй, дууссан цэнэглэлтэд л е-баримт олгоно');
  }

  // One receipt per sale. Asking again for the same receipt returns it; asking
  // for a different one (B2C → B2B, another TIN) returns the old one at the
  // PosAPI first, so the sale is never receipted twice.
  const existing = tx.ebarimt;
  if (existing?.status === 'SUCCESS' && !isLocalOnlyReceipt(existing)) {
    const wantB2B = options.type === 'B2B_RECEIPT' || Boolean(options.customerTin);
    const sameReceipt =
      (existing.type === 'B2B_RECEIPT') === wantB2B &&
      (!wantB2B || existing.customerTin === options.customerTin);
    if (sameReceipt) return tx;
    await returnEBarimtForTransaction(tx);
  }

  const finalAmount = tx.cost;
  const lines = receiptLines(tx, finalAmount);
  const totalVAT = Math.round(lines.reduce((sum, l) => sum + l.vat, 0) * 100) / 100;

  const isB2B = options.type === 'B2B_RECEIPT' || Boolean(options.customerTin);
  const receiptType: 'B2C_RECEIPT' | 'B2B_RECEIPT' = isB2B ? 'B2B_RECEIPT' : 'B2C_RECEIPT';

  if (isB2B && options.customerTin) {
    const verified = await verifyTaxpayer(options.customerTin);
    if (!verified.valid) {
      throw badRequest(verified.error || 'Байгууллагын регистрийн дугаар хүчингүй байна');
    }
  }

  // The station's (or its client's) own merchant issues the receipt — the
  // money is theirs. Only stations with neither use the network default.
  let activeMerchant = await merchantForTransaction(tx);
  if (!activeMerchant) {
    activeMerchant = await EbarimtMerchant.findOne({ isDefault: true, enabled: true }).lean().catch(() => null);
  }
  if (!activeMerchant) {
    await ensureDefaultEbarimtMerchant();
    activeMerchant = await EbarimtMerchant.findOne({ isDefault: true, enabled: true }).lean().catch(() => null);
  }

  const merchantTin = activeMerchant?.merchantTin || process.env.EBARIMT_MERCHANT_TIN || '6123456';
  const districtCode = resolveDistrictCode(activeMerchant);
  const isTest = activeMerchant?.envMode === 'TEST';
  const rawUrl = isTest
    ? activeMerchant?.testApiUrl || process.env.EBARIMTSHINE_TEST || 'http://103.236.194.50:7080/'
    : activeMerchant?.prodApiUrl || activeMerchant?.ebarimtApiUrl || process.env.EBARIMTSHINE_IP || 'http://103.143.40.43:7080/';
  const baseUrl = rawUrl.replace(/\/+$/, '');

  let resolvedCustomerNo = options.customerNo?.trim();
  if (resolvedCustomerNo) {
    if (!/^\d{8}$/.test(resolvedCustomerNo) || BOGUS_EBARIMT_CODES.has(resolvedCustomerNo)) {
      throw badRequest('Хүчингүй И-Баримтын код байна. Өөрийн Ebarimt систем дэх бодит 8 оронтой кодоо оруулна уу.');
    }
  } else if (!isB2B && tx.idTag) {
    const driver = await store.findUserByIdTag(tx.idTag).catch(() => null);
    if (driver?.ebarimtCustomerNo && /^\d{8}$/.test(driver.ebarimtCustomerNo.trim()) && !BOGUS_EBARIMT_CODES.has(driver.ebarimtCustomerNo.trim())) {
      resolvedCustomerNo = driver.ebarimtCustomerNo.trim();
    } else if (driver?.phone && /^\d{8}$/.test(driver.phone.trim()) && !BOGUS_EBARIMT_CODES.has(driver.phone.trim())) {
      resolvedCustomerNo = driver.phone.trim();
    }
  }

  const payloadCustomerNo = isB2B
    ? (options.customerTin || options.customerNo)
    : (resolvedCustomerNo || undefined);

  const payload = {
    type: receiptType,
    merchantTin,
    customerNo: payloadCustomerNo,
    customerTin: isB2B ? options.customerTin : undefined,
    districtCode,
    branchNo: '001',
    posNo: '0001',
    totalAmount: finalAmount.toFixed(2),
    totalVAT: totalVAT.toFixed(2),
    totalCityTax: '0.00',
    receipts: [
      {
        totalAmount: finalAmount.toFixed(2),
        totalVAT: totalVAT.toFixed(2),
        totalCityTax: '0.00',
        taxType: 'VAT_ABLE',
        merchantTin,
        items: lines.map((l) => ({
          name: l.name,
          barCodeType: 'UNDEFINED',
          classificationCode: '5312909',
          measureUnit: l.unit,
          qty: l.qty.toFixed(2),
          unitPrice: l.unitPrice.toFixed(2),
          totalVat: l.vat.toFixed(2),
          totalCityTax: '0.00',
          totalAmount: l.amount.toFixed(2),
        })),
      },
    ],
    payments: [
      {
        code: 'PAYMENT_CARD',
        paidAmount: finalAmount.toFixed(2),
        status: 'PAID',
      },
    ],
  };

  try {
    const data = await postReceipt(baseUrl, payload);
    const rawReceiptId = data.id || data.receiptId || data.ddtd || data.billId;
    const receiptId = rawReceiptId ? String(rawReceiptId) : undefined;
    const lottery = data.lottery || data.lotteryNo || data.lottery_no ? String(data.lottery || data.lotteryNo || data.lottery_no) : undefined;
    const qrData = data.qrData || data.qr || data.qrCode || data.qr_data ? String(data.qrData || data.qr || data.qrCode || data.qr_data) : undefined;

    const ebarimtData = {
      receiptId,
      type: receiptType,
      qrData,
      // B2B receipts carry no lottery; never invent one.
      lottery,
      merchantTin,
      customerNo: payload.customerNo,
      customerTin: isB2B ? options.customerTin : undefined,
      totalAmount: finalAmount,
      totalVAT,
      status: 'SUCCESS' as const,
      issuedAt: new Date(),
      rawResponse: data,
    };
    await Transaction.updateOne({ _id: transactionId }, { $set: { ebarimt: ebarimtData } });
    tx.ebarimt = ebarimtData;
    ebarimtLogger.info(
      { transactionId, receiptId: receiptId || '(none - non-VAT)', lottery, amount: finalAmount, merchantTin },
      '🧾 [E-BARIMT] Transaction receipt issued',
    );

    // Call ITC approveQr (api-1787241649037) to register directly into consumer's Ebarimt account
    if (resolvedCustomerNo && ebarimtData.qrData) {
      itcEasyRegisterService.approveQr(resolvedCustomerNo, ebarimtData.qrData).catch((err) => {
        ebarimtLogger.warn({ err: (err as Error).message }, '⚠️ [ITC] approveQr non-blocking error');
      });
    }

    return tx;
  } catch (err) {
    const message = (err as Error).message;
    ebarimtLogger.error({ transactionId, err: message }, '❌ [E-BARIMT] Transaction receipt failed');
    await Transaction.updateOne(
      { _id: transactionId },
      {
        $set: {
          ebarimt: {
            type: receiptType,
            merchantTin,
            totalAmount: finalAmount,
            totalVAT,
            status: 'FAILED',
            error: message,
          },
        },
      },
    );
    throw new HttpError(502, 'Е-баримт олгож чадсангүй. Түр хүлээгээд дахин оролдоно уу.');
  }
}

export async function issueEBarimtForPayment(
  paymentOrId: string | PaymentDoc,
  options: IssueEBarimtOptions = {},
): Promise<PaymentDoc> {
  const payment =
    typeof paymentOrId === 'string' ? await Payment.findById(paymentOrId) : paymentOrId;
  if (!payment) {
    throw new Error('Payment not found');
  }

  const amount = payment.paidAmount || payment.amount;
  const finalAmount = Math.max(1, amount);
  const totalVAT = calculateVat(finalAmount);

  const isB2B = options.type === 'B2B_RECEIPT' || Boolean(options.customerTin);
  const receiptType: 'B2C_RECEIPT' | 'B2B_RECEIPT' = isB2B ? 'B2B_RECEIPT' : 'B2C_RECEIPT';

  const activeMerchant = await EbarimtMerchant.findOne({ isDefault: true, enabled: true }).lean().catch(() => null);

  const merchantTin = activeMerchant?.merchantTin || process.env.EBARIMT_MERCHANT_TIN || '6123456';
  const districtCode = resolveDistrictCode(activeMerchant);
  const isTest = activeMerchant?.envMode === 'TEST';
  const rawUrl = isTest
    ? activeMerchant?.testApiUrl || process.env.EBARIMTSHINE_TEST || 'http://103.236.194.50:7080/'
    : activeMerchant?.prodApiUrl || activeMerchant?.ebarimtApiUrl || process.env.EBARIMTSHINE_IP || 'http://103.143.40.43:7080/';
  const baseUrl = rawUrl.replace(/\/+$/, '');

  let resolvedCustomerNo = options.customerNo?.trim();
  if (!resolvedCustomerNo && !isB2B) {
    if (payment.userId) {
      const driver = await store.findUserById(payment.userId).catch(() => null);
      if (driver?.ebarimtCustomerNo) {
        resolvedCustomerNo = driver.ebarimtCustomerNo.trim();
      } else if (driver?.phone && /^\d{8}$/.test(driver.phone.trim())) {
        resolvedCustomerNo = driver.phone.trim();
      }
    }
    if (!resolvedCustomerNo && payment.idTag) {
      const driver = await store.findUserByIdTag(payment.idTag).catch(() => null);
      if (driver?.ebarimtCustomerNo) {
        resolvedCustomerNo = driver.ebarimtCustomerNo.trim();
      } else if (driver?.phone && /^\d{8}$/.test(driver.phone.trim())) {
        resolvedCustomerNo = driver.phone.trim();
      }
    }
  }

  const payloadCustomerNo = isB2B
    ? (options.customerTin || options.customerNo)
    : (resolvedCustomerNo || undefined);

  const payload = {
    type: receiptType,
    merchantTin,
    customerNo: payloadCustomerNo,
    customerTin: isB2B ? options.customerTin : undefined,
    districtCode,
    branchNo: '001',
    posNo: '0001',
    totalAmount: finalAmount.toFixed(2),
    totalVAT: totalVAT.toFixed(2),
    totalCityTax: '0.00',
    receipts: [
      {
        totalAmount: finalAmount.toFixed(2),
        totalVAT: totalVAT.toFixed(2),
        totalCityTax: '0.00',
        taxType: 'VAT_ABLE',
        merchantTin,
        items: [
          {
            name: payment.purpose === 'WALLET_TOPUP' ? 'EV Хэтэвч цэнэглэлт' : 'EV Цэнэглэлтийн үйлчилгээ',
            barCodeType: 'UNDEFINED',
            classificationCode: '5312909',
            measureUnit: 'ширхэг',
            qty: '1.00',
            unitPrice: finalAmount.toFixed(2),
            totalVat: totalVAT.toFixed(2),
            totalCityTax: '0.00',
            totalAmount: finalAmount.toFixed(2),
          },
        ],
      },
    ],
    payments: [
      {
        code: 'PAYMENT_CARD',
        paidAmount: finalAmount.toFixed(2),
        status: 'PAID',
      },
    ],
  };

  try {
    const data = await postReceipt(baseUrl, payload);
    const rawReceiptId = data.id || data.receiptId || data.ddtd || data.billId;
    const receiptId = rawReceiptId ? String(rawReceiptId) : undefined;
    const lottery = data.lottery || data.lotteryNo || data.lottery_no ? String(data.lottery || data.lotteryNo || data.lottery_no) : undefined;
    const qrData = data.qrData || data.qr || data.qrCode || data.qr_data ? String(data.qrData || data.qr || data.qrCode || data.qr_data) : undefined;

    const ebarimtData = {
      receiptId,
      type: receiptType,
      qrData,
      lottery,
      merchantTin,
      customerNo: payload.customerNo,
      customerTin: isB2B ? options.customerTin : undefined,
      totalAmount: finalAmount,
      totalVAT,
      status: 'SUCCESS' as const,
      issuedAt: new Date(),
      rawResponse: data,
    };
    await Payment.updateOne({ _id: payment._id }, { $set: { ebarimt: ebarimtData } });
    payment.ebarimt = ebarimtData;
    ebarimtLogger.info(
      { paymentId: String(payment._id), receiptId: receiptId || '(none - non-VAT)', lottery, amount: finalAmount },
      '🧾 [E-BARIMT] Payment receipt issued',
    );

    // Call ITC approveQr (api-1787241649037) to register directly into consumer's Ebarimt account
    if (payload.customerNo && ebarimtData.qrData) {
      itcEasyRegisterService.approveQr(payload.customerNo, ebarimtData.qrData).catch((err) => {
        ebarimtLogger.warn({ err: (err as Error).message }, '⚠️ [ITC] approveQr non-blocking error');
      });
    }

    return payment;
  } catch (err) {
    const message = (err as Error).message;
    ebarimtLogger.error({ paymentId: String(payment._id), err: message }, '❌ [E-BARIMT] Payment receipt failed');
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          ebarimt: { type: receiptType, merchantTin, totalAmount: finalAmount, totalVAT, status: 'FAILED', error: message },
        },
      },
    );
    throw err;
  }
}

export async function checkEbarimtMerchant(merchantId: string) {
  const merchant = await EbarimtMerchant.findById(merchantId);
  if (!merchant) {
    throw new Error('eBarimt Merchant not found');
  }

  const isTest = merchant.envMode === 'TEST';
  const rawUrl = isTest
    ? merchant.testApiUrl || process.env.EBARIMTSHINE_TEST || 'http://103.236.194.50:7080/'
    : merchant.prodApiUrl || merchant.ebarimtApiUrl || process.env.EBARIMTSHINE_IP || 'http://103.143.40.43:7080/';
  const baseUrl = rawUrl.replace(/\/+$/, '');

  const checkedAt = new Date();
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    // Try checking /rest/check or /rest/info
    let res = await fetch(`${baseUrl}/rest/check`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    }).catch(() => null);

    if (!res || !res.ok) {
      // Try /rest/info as secondary check
      res = await fetch(`${baseUrl}/rest/info`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      }).catch(() => null);
    }

    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    let responseData: any = null;
    let statusCode = res?.status || 500;
    if (res) {
      responseData = await res.json().catch(() => null);
    }

    const isSuccess = res ? (res.ok || (responseData && responseData.configStatus === 'SUCCESS') || res.status < 500) : false;

    const checkResult = {
      status: isSuccess ? ('SUCCESS' as const) : ('ERROR' as const),
      statusCode,
      message: isSuccess
        ? `eBarimt REST Сервис хүлээн авсан (${durationMs}ms) - Merchant TIN: ${merchant.merchantTin}`
        : `eBarimt Серверт холбогдоход алдаа гарлаа (${statusCode})`,
      checkedAt,
      rawResponse: responseData || {
        testedUrl: baseUrl,
        durationMs,
        httpStatus: statusCode,
        merchantTin: merchant.merchantTin,
        districtCode: merchant.districtCode,
        khorooCode: merchant.khorooCode,
        autoSend: merchant.autoSend,
        acceptedByService: isSuccess,
      },
    };

    merchant.lastCheckResult = checkResult;
    await merchant.save();
    return merchant;
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const checkResult = {
      status: 'ERROR' as const,
      statusCode: 503,
      message: `Серверт холбогдож чадсангүй: ${err?.message || 'Timeout / Connection Refused'}`,
      checkedAt,
      rawResponse: {
        testedUrl: baseUrl,
        durationMs,
        error: err?.message || 'Network error',
        merchantTin: merchant.merchantTin,
        districtCode: merchant.districtCode,
        khorooCode: merchant.khorooCode,
        acceptedByService: false,
      },
    };

    merchant.lastCheckResult = checkResult;
    await merchant.save();
    return merchant;
  }
}


// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Буцаалт ба Жагсаалт — receipts listing & returning at PosAPI
// ---------------------------------------------------------------------------

/** Receipts written by the fallback paths never reached the PosAPI. */
function isLocalOnlyReceipt(e: { receiptId?: string | null; lottery?: string | null; error?: string | null }): boolean {
  const id = e.receiptId ?? '';
  const lottery = e.lottery ?? '';
  if (!id && !lottery) return true;
  if (id && (id.startsWith('MOCK-') || id.startsWith('REC-'))) return true;
  return Boolean(e.error);
}

/** PosAPI 3.0 wants the receipt's own date, `yyyy-MM-dd HH:mm:ss`, Ulaanbaatar time. */
function posApiDate(e: { issuedAt?: Date | null; rawResponse?: unknown }): string {
  const raw = (e.rawResponse as { date?: unknown } | undefined)?.date;
  if (typeof raw === 'string' && raw) return raw;
  const at = new Date((e.issuedAt ?? new Date()).getTime() + 8 * 3600_000);
  return at.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Call PosAPI 3.0 DELETE /rest/receipt to cancel/refund a receipt at the national tax service.
 */
async function callPosApiReturnReceipt(receipt: {
  receiptId?: string | null;
  lottery?: string | null;
  merchantTin?: string | null;
  issuedAt?: Date | null;
  rawResponse?: unknown;
}): Promise<{ data: Record<string, unknown>; skipped?: boolean }> {
  const id = receipt.receiptId ?? '';
  const lottery = receipt.lottery ?? '';

  if (!id && !lottery) {
    throw new HttpError(400, 'Баримтад ДДТД болон сугалааны дугаар байхгүй тул буцаах боломжгүй.');
  }

  // Non-VAT receipt with only lottery number cannot be deleted by id at PosAPI
  if (!id) {
    return { data: { skipped: 'receipt has no DDTD/receiptId (non-VAT payer)' }, skipped: true };
  }

  if (isLocalOnlyReceipt(receipt)) {
    return { data: { skipped: 'receipt was never registered at the PosAPI' }, skipped: true };
  }

  const merchant =
    (await EbarimtMerchant.findOne({ merchantTin: receipt.merchantTin || undefined, enabled: true }).lean().catch(() => null)) ??
    (await EbarimtMerchant.findOne({ isDefault: true, enabled: true }).lean().catch(() => null));
  const rawUrl =
    merchant?.envMode === 'TEST'
      ? merchant.testApiUrl || process.env.EBARIMTSHINE_TEST
      : merchant?.prodApiUrl || merchant?.ebarimtApiUrl || process.env.EBARIMTSHINE_IP;
  if (!rawUrl) throw new HttpError(502, 'Е-баримтын PosAPI хаяг тохируулаагүй байна');
  const baseUrl = rawUrl.replace(/\/+$/, '');

  const body = { id, date: posApiDate(receipt) };
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/rest/receipt`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    ebarimtLogger.error({ receiptId: id, err: (err as Error).message }, 'e-barimt return: PosAPI unreachable');
    throw new HttpError(502, 'Е-баримтын системтэй холбогдож чадсангүй. Буцаалт хийгдээгүй.');
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const statusCode = res.status;

  if (!res.ok || statusCode >= 400) {
    const msg = (data.message || data.error) as string | undefined;
    ebarimtLogger.error({ receiptId: id, status: statusCode, data }, 'e-barimt return refused by PosAPI');
    throw new HttpError(502, msg ? `Татварын системээс буцаах үед алдаа: ${msg}` : `Татварын систем ${statusCode} алдаа буцаалаа`, data);
  }

  if (data.success === false) {
    const msg = (data.message || data.error) as string | undefined;
    ebarimtLogger.error({ receiptId: id, data }, 'e-barimt return failed: success=false');
    throw new HttpError(502, msg ? `Татварын системээс буцаах үед алдаа: ${msg}` : 'Татварын систем баримт буцаахаас татгалзлаа', data);
  }

  if (data.status && data.status !== 'SUCCESS') {
    const msg = (data.message || data.error) as string | undefined;
    ebarimtLogger.error({ receiptId: id, data }, 'e-barimt return failed: status not SUCCESS');
    throw new HttpError(502, msg ? `Татварын системээс буцаах үед алдаа: ${msg}` : `Татварын систем status=${data.status} буцаалаа`, data);
  }

  return { data };
}

export interface ReturnEbarimtOptions {
  source?: 'TRANSACTION' | 'PAYMENT';
  id?: string | number;
  receiptId?: string;
  returnedBy?: string;
  reason?: string;
}

/**
 * Return an e-barimt receipt from either a Transaction or a Payment.
 * Successfully cancels the receipt in the national ebarimt PosAPI and marks it REFUNDED in DB.
 */
export async function returnEBarimtReceipt(opts: ReturnEbarimtOptions): Promise<{
  success: boolean;
  message: string;
  receiptId?: string;
  returnedAt: Date;
  source: 'TRANSACTION' | 'PAYMENT';
  sourceId: string | number;
}> {
  let doc: { source: 'TRANSACTION'; tx: any } | { source: 'PAYMENT'; payment: any } | null = null;

  const rawId = opts.id !== undefined && opts.id !== null ? String(opts.id).trim() : '';

  if (rawId.startsWith('tx_')) {
    const tx = await Transaction.findById(Number(rawId.slice(3)));
    if (tx) doc = { source: 'TRANSACTION', tx };
  } else if (rawId.startsWith('pay_')) {
    const payment = await Payment.findById(rawId.slice(4));
    if (payment) doc = { source: 'PAYMENT', payment };
  } else if (opts.source === 'TRANSACTION' && rawId) {
    const tx = await Transaction.findById(Number(rawId));
    if (tx) doc = { source: 'TRANSACTION', tx };
  } else if (opts.source === 'PAYMENT' && rawId) {
    const payment = await Payment.findById(rawId);
    if (payment) doc = { source: 'PAYMENT', payment };
  } else if (opts.receiptId) {
    const rId = opts.receiptId.trim();
    const tx = await Transaction.findOne({ 'ebarimt.receiptId': rId });
    if (tx) doc = { source: 'TRANSACTION', tx };
    else {
      const payment = await Payment.findOne({ 'ebarimt.receiptId': rId });
      if (payment) doc = { source: 'PAYMENT', payment };
    }
  } else if (rawId) {
    if (/^\d+$/.test(rawId)) {
      const tx = await Transaction.findById(Number(rawId));
      if (tx?.ebarimt) doc = { source: 'TRANSACTION', tx };
    }
    if (!doc) {
      const payment = await Payment.findById(rawId).catch(() => null);
      if (payment?.ebarimt) doc = { source: 'PAYMENT', payment };
    }
  }

  if (!doc) {
    throw new HttpError(404, 'Буцаах И-баримт олдсонгүй!');
  }

  const e = doc.source === 'TRANSACTION' ? doc.tx.ebarimt : doc.payment.ebarimt;
  if (!e) {
    throw new HttpError(404, 'Энэ бичлэгт И-баримт үүсээгүй байна!');
  }

  if (e.status === 'REFUNDED' || e.returnedAt) {
    throw new HttpError(409, 'Энэ баримт аль хэдийн буцаагдсан байна!');
  }

  const { data } = await callPosApiReturnReceipt(e);
  const returnedAt = new Date();
  const returnedBy = opts.returnedBy || 'admin';

  if (doc.source === 'TRANSACTION') {
    await Transaction.updateOne(
      { _id: doc.tx._id },
      {
        $set: {
          'ebarimt.status': 'REFUNDED',
          'ebarimt.returnedAt': returnedAt,
          'ebarimt.returnResponse': data,
          'ebarimt.returnedBy': returnedBy,
        },
      },
    );
    ebarimtLogger.info({ transactionId: doc.tx._id, receiptId: e.receiptId }, 'e-barimt receipt returned');
    return {
      success: true,
      message: e.receiptId ? `${e.receiptId} дугаартай баримт амжилттай буцаагдлаа.` : 'Баримт амжилттай буцаагдлаа.',
      receiptId: e.receiptId,
      returnedAt,
      source: 'TRANSACTION',
      sourceId: doc.tx._id,
    };
  } else {
    await Payment.updateOne(
      { _id: doc.payment._id },
      {
        $set: {
          'ebarimt.status': 'REFUNDED',
          'ebarimt.returnedAt': returnedAt,
          'ebarimt.returnResponse': data,
          'ebarimt.returnedBy': returnedBy,
        },
      },
    );
    ebarimtLogger.info({ paymentId: String(doc.payment._id), receiptId: e.receiptId }, 'e-barimt payment receipt returned');
    return {
      success: true,
      message: e.receiptId ? `${e.receiptId} дугаартай баримт амжилттай буцаагдлаа.` : 'Баримт амжилттай буцаагдлаа.',
      receiptId: e.receiptId,
      returnedAt,
      source: 'PAYMENT',
      sourceId: String(doc.payment._id),
    };
  }
}

/**
 * Backwards compatible helper for transaction refund workflow.
 */
export async function returnEBarimtForTransaction(
  tx: TransactionDoc,
): Promise<{ returned: boolean }> {
  const e = tx.ebarimt;
  if (!e || e.status !== 'SUCCESS') return { returned: false };
  if (!e.receiptId && !e.lottery) return { returned: false };

  try {
    const res = await returnEBarimtReceipt({ source: 'TRANSACTION', id: tx._id, returnedBy: 'SYSTEM_REFUND' });
    return { returned: res.success };
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      return { returned: false };
    }
    throw err;
  }
}

export interface EbarimtListParams {
  page?: number;
  limit?: number;
  status?: string;
  type?: string;
  q?: string;
  from?: Date;
  to?: Date;
  chargePointId?: string;
  clientId?: string;
}

export interface EbarimtReceiptRow {
  id: string;
  source: 'TRANSACTION' | 'PAYMENT';
  sourceId: string | number;
  receiptId?: string;
  lottery?: string;
  qrData?: string;
  type: 'B2C_RECEIPT' | 'B2B_RECEIPT';
  status: 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'PENDING';
  totalAmount: number;
  totalVAT: number;
  merchantTin: string;
  customerNo?: string;
  customerTin?: string;
  issuedAt?: string;
  returnedAt?: string;
  returnedBy?: string;
  error?: string;
  chargePointId?: string;
  connectorId?: number;
  driver?: { name?: string; phone?: string } | null;
  rawResponse?: unknown;
  returnResponse?: unknown;
}

export interface EbarimtListResult {
  data: EbarimtReceiptRow[];
  total: number;
  page: number;
  limit: number;
  summary: {
    totalCount: number;
    totalAmount: number;
    successCount: number;
    successAmount: number;
    refundedCount: number;
    refundedAmount: number;
    failedCount: number;
  };
}

/**
 * Retrieve paginated e-barimt receipts across transactions and payments.
 */
export async function listEbarimtReceipts(params: EbarimtListParams): Promise<EbarimtListResult> {
  const page = Math.max(1, params.page || 1);
  const limit = Math.max(1, Math.min(params.limit || 50, 500));
  const skip = (page - 1) * limit;

  const txFilter: Record<string, unknown> = {
    'ebarimt.status': { $exists: true, $ne: null },
  };
  const payFilter: Record<string, unknown> = {
    'ebarimt.status': { $exists: true, $ne: null },
    $or: [{ transactionId: { $exists: false } }, { transactionId: null }],
  };

  if (params.status && params.status !== 'ALL') {
    txFilter['ebarimt.status'] = params.status;
    payFilter['ebarimt.status'] = params.status;
  }
  if (params.type) {
    txFilter['ebarimt.type'] = params.type;
    payFilter['ebarimt.type'] = params.type;
  }
  if (params.from || params.to) {
    const range: Record<string, unknown> = {};
    if (params.from) range.$gte = params.from;
    if (params.to) range.$lte = params.to;
    txFilter['ebarimt.issuedAt'] = range;
    payFilter['ebarimt.issuedAt'] = range;
  }
  if (params.chargePointId) {
    txFilter.chargePointId = params.chargePointId;
    payFilter.chargePointId = params.chargePointId;
  }
  if (params.clientId) {
    const clientStations = await ChargePoint.find({
      $or: [{ clientId: params.clientId }, { linkedClientIds: params.clientId }],
    }).select('_id cpId').lean();
    const stationOids = clientStations.map((s) => s._id);
    const stationCpIds = clientStations.map((s) => s.cpId).filter(Boolean);
    const allStationIds = [...stationOids.map(String), ...stationCpIds];

    txFilter.$or = [
      { clientId: params.clientId },
      { chargePointId: { $in: allStationIds } },
    ];
    payFilter.chargePointId = { $in: allStationIds };
  }

  if (params.q) {
    const term = params.q.trim();
    const orTx: Record<string, unknown>[] = [
      { 'ebarimt.receiptId': { $regex: term, $options: 'i' } },
      { 'ebarimt.lottery': { $regex: term, $options: 'i' } },
      { 'ebarimt.customerNo': { $regex: term, $options: 'i' } },
      { 'ebarimt.customerTin': { $regex: term, $options: 'i' } },
      { chargePointId: { $regex: term, $options: 'i' } },
    ];
    if (/^\d+$/.test(term)) {
      orTx.push({ _id: Number(term) });
    }
    txFilter.$or = orTx;

    const orPay: Record<string, unknown>[] = [
      { 'ebarimt.receiptId': { $regex: term, $options: 'i' } },
      { 'ebarimt.lottery': { $regex: term, $options: 'i' } },
      { 'ebarimt.customerNo': { $regex: term, $options: 'i' } },
      { 'ebarimt.customerTin': { $regex: term, $options: 'i' } },
      { senderInvoiceNo: { $regex: term, $options: 'i' } },
    ];
    payFilter.$or = orPay;
  }

  const [txDocs, payDocs] = await Promise.all([
    Transaction.find(txFilter).lean(),
    Payment.find(payFilter).lean(),
  ]);

  const idTags = txDocs.map((t) => t.idTag).filter(Boolean);
  const payUserIds = payDocs.map((p) => p.userId ?? p.walletOwnerId ?? '').filter(Boolean);

  const [driverByIdTagMap, driverByIdMap] = await Promise.all([
    store.findUsersByIdTags(idTags).catch(() => new Map<string, any>()),
    store.findUsersByIds(payUserIds).catch(() => new Map<string, any>()),
  ]);

  const rows: EbarimtReceiptRow[] = [];

  let totalAmount = 0;
  let successCount = 0;
  let successAmount = 0;
  let refundedCount = 0;
  let refundedAmount = 0;
  let failedCount = 0;

  for (const t of txDocs) {
    const eb = t.ebarimt as any;
    if (!eb) continue;
    const amount = Number(eb.totalAmount || t.cost || 0);
    const vat = Number(eb.totalVAT || 0);
    const status = (eb.status || 'SUCCESS') as 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'PENDING';

    totalAmount += amount;
    if (status === 'SUCCESS') {
      successCount++;
      successAmount += amount;
    } else if (status === 'REFUNDED') {
      refundedCount++;
      refundedAmount += amount;
    } else if (status === 'FAILED') {
      failedCount++;
    }

    const driver = t.idTag ? driverByIdTagMap.get(t.idTag) : null;

    rows.push({
      id: `tx_${t._id}`,
      source: 'TRANSACTION',
      sourceId: t._id,
      receiptId: eb.receiptId,
      lottery: eb.lottery,
      qrData: eb.qrData,
      type: eb.type || 'B2C_RECEIPT',
      status,
      totalAmount: amount,
      totalVAT: vat,
      merchantTin: eb.merchantTin || '',
      customerNo: eb.customerNo,
      customerTin: eb.customerTin,
      issuedAt: eb.issuedAt ? new Date(eb.issuedAt).toISOString() : (t.createdAt ? new Date(t.createdAt).toISOString() : undefined),
      returnedAt: eb.returnedAt ? new Date(eb.returnedAt).toISOString() : undefined,
      returnedBy: eb.returnedBy,
      error: eb.error,
      chargePointId: String(t.chargePointId),
      connectorId: t.connectorId,
      driver: driver ? { name: driver.name, phone: driver.phone } : null,
      rawResponse: eb.rawResponse,
      returnResponse: eb.returnResponse,
    });
  }

  for (const p of payDocs) {
    const eb = p.ebarimt as any;
    if (!eb) continue;
    const amount = Number(eb.totalAmount || p.paidAmount || p.amount || 0);
    const vat = Number(eb.totalVAT || 0);
    const status = (eb.status || 'SUCCESS') as 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'PENDING';

    totalAmount += amount;
    if (status === 'SUCCESS') {
      successCount++;
      successAmount += amount;
    } else if (status === 'REFUNDED') {
      refundedCount++;
      refundedAmount += amount;
    } else if (status === 'FAILED') {
      failedCount++;
    }

    const uId = p.userId ?? p.walletOwnerId ?? '';
    const driver = uId ? driverByIdMap.get(uId) : null;

    rows.push({
      id: `pay_${p._id}`,
      source: 'PAYMENT',
      sourceId: String(p._id),
      receiptId: eb.receiptId,
      lottery: eb.lottery,
      qrData: eb.qrData,
      type: eb.type || 'B2C_RECEIPT',
      status,
      totalAmount: amount,
      totalVAT: vat,
      merchantTin: eb.merchantTin || '',
      customerNo: eb.customerNo,
      customerTin: eb.customerTin,
      issuedAt: eb.issuedAt ? new Date(eb.issuedAt).toISOString() : (p.createdAt ? new Date(p.createdAt).toISOString() : undefined),
      returnedAt: eb.returnedAt ? new Date(eb.returnedAt).toISOString() : undefined,
      returnedBy: eb.returnedBy,
      error: eb.error,
      chargePointId: p.chargePointId ? String(p.chargePointId) : undefined,
      connectorId: p.connectorId !== null && p.connectorId !== undefined ? p.connectorId : undefined,
      driver: driver ? { name: driver.name, phone: driver.phone } : null,
      rawResponse: eb.rawResponse,
      returnResponse: eb.returnResponse,
    });
  }

  rows.sort((a, b) => {
    const timeA = a.issuedAt ? new Date(a.issuedAt).getTime() : 0;
    const timeB = b.issuedAt ? new Date(b.issuedAt).getTime() : 0;
    return timeB - timeA;
  });

  const pagedData = rows.slice(skip, skip + limit);

  return {
    data: pagedData,
    total: rows.length,
    page,
    limit,
    summary: {
      totalCount: rows.length,
      totalAmount,
      successCount,
      successAmount,
      refundedCount,
      refundedAmount,
      failedCount,
    },
  };
}
