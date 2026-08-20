import { authorizedFetch } from './tokens';

/**
 * Thin typed wrapper over the QPay merchant API (merchant.qpay.mn /
 * merchant-sandbox.qpay.mn). Only transport concerns live here — no database
 * writes, no business rules; see services/payment.service.ts for those.
 */

export interface QpayInvoiceLine {
  line_description: string;
  line_quantity: string;
  line_unit_price: string;
  tax_product_code?: string;
  note?: string;
}

export interface CreateInvoiceInput {
  invoice_code: string;
  sender_invoice_no: string;
  invoice_receiver_code: string;
  invoice_description: string;
  amount: number;
  callback_url: string;
  sender_branch_code?: string;
  invoice_due_date?: string;
  enable_expiry?: boolean;
  expiry_date?: string;
  allow_partial?: boolean;
  minimum_amount?: number;
  allow_exceed?: boolean;
  maximum_amount?: number;
  note?: string;
  lines?: QpayInvoiceLine[];
  invoice_receiver_data?: {
    register?: string;
    name?: string;
    email?: string;
    phone?: string;
  };
}

export interface QpayUrl {
  name?: string;
  description?: string;
  logo?: string;
  link?: string;
}

export interface CreateInvoiceResult {
  invoice_id: string;
  qr_text?: string;
  qr_image?: string;
  qPay_shortUrl?: string;
  urls?: QpayUrl[];
}

export interface QpayPaymentRow {
  payment_id: string;
  payment_status?: string;
  payment_amount?: string | number;
  payment_currency?: string;
  payment_wallet?: string;
  payment_type?: string;
  payment_date?: string;
  transaction_type?: string;
  object_id?: string;
  object_type?: string;
}

export interface PaymentCheckResult {
  count?: number;
  paid_amount?: string | number;
  rows?: QpayPaymentRow[];
}

export interface InvoiceDetail {
  invoice_id?: string;
  invoice_status?: string;
  sender_invoice_no?: string;
  invoice_description?: string;
  total_amount?: string | number;
  gross_amount?: string | number;
  payment_date?: string;
  [key: string]: unknown;
}

export function createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
  return authorizedFetch<CreateInvoiceResult>('merchant', {
    method: 'POST',
    path: '/v2/invoice',
    label: 'POST /v2/invoice',
    body: input,
  });
}

export function getInvoice(invoiceId: string): Promise<InvoiceDetail> {
  return authorizedFetch<InvoiceDetail>('merchant', {
    method: 'GET',
    path: `/v2/invoice/${encodeURIComponent(invoiceId)}`,
    label: 'GET /v2/invoice/:id',
  });
}

export function cancelInvoice(invoiceId: string): Promise<unknown> {
  return authorizedFetch<unknown>('merchant', {
    method: 'DELETE',
    path: `/v2/invoice/${encodeURIComponent(invoiceId)}`,
    label: 'DELETE /v2/invoice/:id',
  });
}

/** List the payments QPay has recorded against one invoice. */
export function checkPayment(
  invoiceId: string,
  offset: { page_number: number; page_limit: number } = { page_number: 1, page_limit: 100 },
): Promise<PaymentCheckResult> {
  return authorizedFetch<PaymentCheckResult>('merchant', {
    method: 'POST',
    path: '/v2/payment/check',
    label: 'POST /v2/payment/check',
    body: { object_type: 'INVOICE', object_id: invoiceId, offset },
  });
}

export function getPayment(paymentId: string): Promise<QpayPaymentRow> {
  return authorizedFetch<QpayPaymentRow>('merchant', {
    method: 'GET',
    path: `/v2/payment/${encodeURIComponent(paymentId)}`,
    label: 'GET /v2/payment/:id',
  });
}

export function cancelPayment(paymentId: string, note?: string): Promise<unknown> {
  return authorizedFetch<unknown>('merchant', {
    method: 'DELETE',
    path: `/v2/payment/cancel/${encodeURIComponent(paymentId)}`,
    label: 'DELETE /v2/payment/cancel/:id',
    body: note ? { callback_url: undefined, note } : undefined,
  });
}

/** Refund a settled payment. Amount is decided by QPay from the original payment. */
export function refundPayment(paymentId: string, note?: string): Promise<unknown> {
  return authorizedFetch<unknown>('merchant', {
    method: 'DELETE',
    path: `/v2/payment/refund/${encodeURIComponent(paymentId)}`,
    label: 'DELETE /v2/payment/refund/:id',
    body: note ? { note } : undefined,
  });
}
