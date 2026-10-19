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
  if (!(data?.id || data?.receiptId)) {
    throw new ReceiptError('PosAPI answered without a receipt id');
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
export async function verifyTaxpayer(tinOrRegNo: string): Promise<{ valid: boolean; name?: string; tin?: string; error?: string }> {
  const clean = tinOrRegNo.trim();
  if (!clean) return { valid: false, error: 'Татвар төлөгчийн дугаар хоосон байна' };

  try {
    // 1. Check as TIN
    const tinRes = await fetch(`https://api.ebarimt.mn/api/info/check/getInfo?tin=${encodeURIComponent(clean)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (tinRes.ok) {
      const data = (await tinRes.json().catch(() => null)) as { status?: number; data?: { found?: boolean; name?: string } };
      if (data?.status === 200 && data.data?.found) {
        return { valid: true, name: data.data.name, tin: clean };
      }
    }

    // 2. Check as enterprise registration number (e.g. 7-digit RD)
    const regRes = await fetch(`https://api.ebarimt.mn/api/info/check/getTinInfo?regNo=${encodeURIComponent(clean)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (regRes.ok) {
      const data = (await regRes.json().catch(() => null)) as { status?: number; data?: string | number };
      if (data?.status === 200 && data.data) {
        const resolvedTin = String(data.data);
        const nameRes = await fetch(`https://api.ebarimt.mn/api/info/check/getInfo?tin=${encodeURIComponent(resolvedTin)}`, {
          signal: AbortSignal.timeout(4000),
        }).catch(() => null);
        const nameData = nameRes && nameRes.ok ? ((await nameRes.json().catch(() => null)) as { data?: { name?: string } }) : null;
        return { valid: true, name: nameData?.data?.name, tin: resolvedTin };
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

  // 3. Official ITC Easy-Register getProfile check (api-1787241529220)
  try {
    const itcRes = await itcEasyRegisterService.getProfile({ customerNo: clean });
    if (itcRes.valid) {
      return {
        valid: true,
        type: 'CITIZEN_CODE',
        name: itcRes.loginName,
        message: itcRes.message,
      };
    }
  } catch {}

  // 4. Check if it matches an organization TIN/Register in central tax authority
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

  // 4. Check if it's an 8-digit individual code or mobile phone
  if (clean.length === 8) {
    const uPhone = (userPhone ?? '').replace(/\D/g, '').slice(-8);
    if (uPhone && clean === uPhone) {
      return {
        valid: true,
        type: 'CITIZEN_PHONE',
        message: 'Таны баталгаажсан гар утасны дугаар. Ebarimt хялбар бүртгэлд шууд холбогдоно.',
      };
    }

    const mobilePrefixes: Record<string, string> = {
      '99': 'Мобиком', '95': 'Мобиком', '94': 'Мобиком', '85': 'Мобиком',
      '88': 'Юнител', '86': 'Юнител', '89': 'Юнител', '80': 'Юнител',
      '90': 'Скайтел', '91': 'Скайтел', '96': 'Скайтел',
      '98': 'Ж-Мобайл', '93': 'Ж-Мобайл', '97': 'Ж-Мобайл', '83': 'Ж-Мобайл',
    };
    const p2 = clean.slice(0, 2);
    if (mobilePrefixes[p2]) {
      return {
        valid: true,
        type: 'CITIZEN_PHONE',
        message: `Хүчинтэй үүрэн холбооны дугаар (${mobilePrefixes[p2]}). Энэ дугаар Ebarimt системд тань бүртгэлтэй эсэхийг нягтална уу.`,
      };
    }

    // Citizen 8-digit E-Barimt code (starts with 1-7)
    if (/^[1-7]\d{7}$/.test(clean)) {
      return {
        valid: true,
        type: 'CITIZEN_CODE',
        message: 'И-Баримтын 8 оронтой хэрэглэгчийн код хүчинтэй бүтэцтэй байна.',
      };
    }
  }

  return {
    valid: false,
    message: 'Хүчингүй код байна. Ebarimt апп-ынхаа 8 оронтой нэвтрэх код, бүртгэлтэй утасны дугаар эсвэл ААН-ийн ТТД-аа оруулна уу.',
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
    const receiptId = String(data.id || data.receiptId);
    const ebarimtData = {
      receiptId,
      type: receiptType,
      qrData: data.qrData || data.qr || data.qrCode || undefined,
      // B2B receipts carry no lottery; never invent one.
      lottery: data.lottery || data.lotteryNo || undefined,
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
      { transactionId, receiptId, amount: finalAmount, merchantTin },
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
    const receiptId = String(data.id || data.receiptId);
    const ebarimtData = {
      receiptId,
      type: receiptType,
      qrData: data.qrData || data.qr || data.qrCode || undefined,
      lottery: data.lottery || data.lotteryNo || undefined,
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
      { paymentId: String(payment._id), receiptId, amount: finalAmount },
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
// Буцаалт — returning (cancelling) a receipt at the PosAPI
// ---------------------------------------------------------------------------

/** Receipts written by the fallback paths above never reached the PosAPI. */
function isLocalOnlyReceipt(e: { receiptId?: string | null; error?: string | null }): boolean {
  const id = e.receiptId ?? '';
  return !id || id.startsWith('MOCK-') || id.startsWith('REC-') || Boolean(e.error);
}

/** PosAPI 3.0 wants the receipt's own date, `yyyy-MM-dd HH:mm:ss`, Ulaanbaatar time. */
function posApiDate(e: { issuedAt?: Date | null; rawResponse?: unknown }): string {
  const raw = (e.rawResponse as { date?: unknown } | undefined)?.date;
  if (typeof raw === 'string' && raw) return raw;
  const at = new Date((e.issuedAt ?? new Date()).getTime() + 8 * 3600_000);
  return at.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Return the e-barimt receipt of a transaction (PosAPI 3.0 `DELETE /rest/receipt`)
 * and mark it REFUNDED. A receipt that never reached the PosAPI is only marked.
 * Throws a 502 when the PosAPI refuses or cannot be reached, so the caller can
 * stop before any money moves.
 */
export async function returnEBarimtForTransaction(
  tx: TransactionDoc,
): Promise<{ returned: boolean }> {
  const e = tx.ebarimt;
  // Nothing was issued (none requested, or the PosAPI call failed): nothing to return.
  if (!e?.receiptId || e.status !== 'SUCCESS') return { returned: false };

  // A fake receipt left by the old fallback code never reached the PosAPI.
  if (isLocalOnlyReceipt(e)) {
    await Transaction.updateOne(
      { _id: tx._id },
      {
        $set: {
          'ebarimt.status': 'REFUNDED',
          'ebarimt.returnedAt': new Date(),
          'ebarimt.returnResponse': { skipped: 'receipt was never registered at the PosAPI' },
        },
      },
    );
    return { returned: false };
  }

  const merchant =
    (await EbarimtMerchant.findOne({ merchantTin: e.merchantTin, enabled: true }).lean().catch(() => null)) ??
    (await EbarimtMerchant.findOne({ isDefault: true, enabled: true }).lean().catch(() => null));
  const rawUrl =
    merchant?.envMode === 'TEST'
      ? merchant.testApiUrl || process.env.EBARIMTSHINE_TEST
      : merchant?.prodApiUrl || merchant?.ebarimtApiUrl || process.env.EBARIMTSHINE_IP;
  if (!rawUrl) throw new HttpError(502, 'Е-баримтын PosAPI хаяг тохируулаагүй байна');
  const baseUrl = rawUrl.replace(/\/+$/, '');

  const body = { id: e.receiptId, date: posApiDate(e) };
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/rest/receipt`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    ebarimtLogger.error({ transactionId: tx._id, err: (err as Error).message }, 'e-barimt return: PosAPI unreachable');
    throw new HttpError(502, 'Е-баримтын системтэй холбогдож чадсангүй. Буцаалт хийгдээгүй.');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    ebarimtLogger.error({ transactionId: tx._id, status: res.status, data }, 'e-barimt return refused by PosAPI');
    throw new HttpError(502, `Е-баримт буцаахад PosAPI алдаа өглөө (HTTP ${res.status}). Буцаалт хийгдээгүй.`, data);
  }

  await Transaction.updateOne(
    { _id: tx._id },
    {
      $set: {
        'ebarimt.status': 'REFUNDED',
        'ebarimt.returnedAt': new Date(),
        'ebarimt.returnResponse': data,
      },
    },
  );
  ebarimtLogger.info({ transactionId: tx._id, receiptId: e.receiptId }, 'e-barimt receipt returned');
  return { returned: true };
}
