import { authorizedFetch } from './tokens';

/**
 * QuickQR API (quickqr.qpay.mn) — the terminal/sub-merchant flavour of QPay from
 * the "Quick Qr 2.0.0" collection. Authentication differs from the merchant API
 * (terminal_id + api key instead of HTTP Basic) but the token handling is shared,
 * see tokens.ts scope 'quickqr'.
 */

export interface AimagHot {
  code?: string;
  name?: string;
  [key: string]: unknown;
}

export interface QuickQrMerchant {
  merchant_id?: string;
  [key: string]: unknown;
}

export interface CompanyMerchantInput {
  register_number: string;
  company_name: string;
  name: string;
  mcc_code: string;
  city: string;
  district: string;
  address: string;
  phone: string;
  email: string;
  name_eng?: string;
  owner_first_name?: string;
  owner_last_name?: string;
  owner_register_no?: string;
  location_lat?: string;
  location_lng?: string;
  max_qr_account_count?: number;
}

export interface PersonMerchantInput {
  register_number: string;
  first_name: string;
  last_name: string;
  business_name: string;
  mcc_code: string;
  city: string;
  district: string;
  address: string;
  phone: string;
  email: string;
  business_name_eng?: string;
  max_qr_account_count?: number;
}

export interface QuickQrBankAccount {
  account_bank_code: string;
  account_number: string;
  account_name: string;
  is_default?: boolean;
}

export interface QuickQrInvoiceInput {
  merchant_id: string;
  amount: number;
  currency?: string;
  description: string;
  mcc_code?: string;
  callback_url?: string;
  bank_accounts?: QuickQrBankAccount[];
}

export interface QuickQrInvoiceResult {
  invoice_id?: string;
  qr_text?: string;
  qr_image?: string;
  qPay_shortUrl?: string;
  urls?: { name?: string; description?: string; logo?: string; link?: string }[];
  [key: string]: unknown;
}

const get = <T>(path: string, label: string) =>
  authorizedFetch<T>('quickqr', { method: 'GET', path, label });

export const listCities = () => get<AimagHot[]>('/v2/aimaghot', 'GET /v2/aimaghot');

export const listDistricts = (cityCode: string) =>
  get<AimagHot[]>(`/v2/sumduureg/${encodeURIComponent(cityCode)}`, 'GET /v2/sumduureg/:city');

export const createCompanyMerchant = (input: CompanyMerchantInput) =>
  authorizedFetch<QuickQrMerchant>('quickqr', {
    method: 'POST',
    path: '/v2/merchant/company',
    label: 'POST /v2/merchant/company',
    body: input,
  });

export const updateCompanyMerchant = (merchantId: string, input: CompanyMerchantInput) =>
  authorizedFetch<QuickQrMerchant>('quickqr', {
    method: 'PUT',
    path: `/v2/merchant/company/${encodeURIComponent(merchantId)}`,
    label: 'PUT /v2/merchant/company/:id',
    body: input,
  });

export const createPersonMerchant = (input: PersonMerchantInput) =>
  authorizedFetch<QuickQrMerchant>('quickqr', {
    method: 'POST',
    path: '/v2/merchant/person',
    label: 'POST /v2/merchant/person',
    body: input,
  });

export const updatePersonMerchant = (merchantId: string, input: PersonMerchantInput) =>
  authorizedFetch<QuickQrMerchant>('quickqr', {
    method: 'PUT',
    path: `/v2/merchant/person/${encodeURIComponent(merchantId)}`,
    label: 'PUT /v2/merchant/person/:id',
    body: input,
  });

export const getMerchant = (merchantId: string) =>
  get<QuickQrMerchant>(`/v2/merchant/${encodeURIComponent(merchantId)}`, 'GET /v2/merchant/:id');

export const deleteMerchant = (merchantId: string) =>
  authorizedFetch<unknown>('quickqr', {
    method: 'DELETE',
    path: `/v2/merchant/${encodeURIComponent(merchantId)}`,
    label: 'DELETE /v2/merchant/:id',
  });

export const listMerchants = (pageNumber = 1, pageLimit = 10) =>
  authorizedFetch<{ rows?: QuickQrMerchant[]; count?: number }>('quickqr', {
    method: 'POST',
    path: '/v2/merchant/list',
    label: 'POST /v2/merchant/list',
    body: { offset: { page_number: pageNumber, page_limit: pageLimit } },
  });

export const createInvoice = (input: QuickQrInvoiceInput) =>
  authorizedFetch<QuickQrInvoiceResult>('quickqr', {
    method: 'POST',
    path: '/v2/invoice',
    label: 'POST /v2/invoice (quickqr)',
    body: { currency: 'MNT', ...input },
  });

export const getInvoice = (invoiceId: string) =>
  get<QuickQrInvoiceResult>(`/v2/invoice/${encodeURIComponent(invoiceId)}`, 'GET /v2/invoice/:id (quickqr)');

export const cancelInvoice = (invoiceId: string) =>
  authorizedFetch<unknown>('quickqr', {
    method: 'DELETE',
    path: `/v2/invoice/${encodeURIComponent(invoiceId)}`,
    label: 'DELETE /v2/invoice/:id (quickqr)',
  });

export interface QuickQrPaymentCheck {
  count?: number;
  paid_amount?: string | number;
  rows?: {
    payment_id: string;
    payment_status?: string;
    payment_amount?: string | number;
    payment_currency?: string;
    payment_wallet?: string;
    payment_date?: string;
    transaction_type?: string;
  }[];
  [key: string]: unknown;
}

export const checkPayment = (invoiceId: string) =>
  authorizedFetch<QuickQrPaymentCheck>('quickqr', {
    method: 'POST',
    path: '/v2/payment/check',
    label: 'POST /v2/payment/check (quickqr)',
    body: { invoice_id: invoiceId },
  });
