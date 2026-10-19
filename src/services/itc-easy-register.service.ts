import mongoose from 'mongoose';
import { ebarimtLogger } from '../lib/logger';
import { ItcToken } from '../models/ItcToken';

interface TokenState {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // ms timestamp
}

let memoryToken: TokenState | null = null;

export interface ItcProfileResponse {
  msg?: string;
  code?: string;
  status?: number;
  loginName?: string;
  email?: string;
}

export interface ItcApproveQrResponse {
  msg?: string;
  code?: string;
  status?: number;
}

export interface ItcConsumerInfoResponse {
  regNo?: string;
  loginName?: string;
  givenName?: string;
  familyName?: string;
}

class ItcEasyRegisterService {
  private get apiUrl(): string {
    return (
      process.env.EBARIMTSHINE_EASY_REGISTER_URL ||
      process.env.ITC_API_URL ||
      'https://service.itc.gov.mn'
    ).replace(/\/+$/, '');
  }

  private get authUrl(): string {
    return (
      process.env.EBARIMTSHINE_AUTH_URL ||
      process.env.ITC_AUTH_URL ||
      'https://auth.itc.gov.mn/auth/realms/ITC/protocol/openid-connect/token'
    );
  }

  private get clientId(): string {
    return process.env.EBARIMTSHINE_CLIENT_ID || process.env.ITC_CLIENT_ID || 'vatps';
  }

  private get username(): string {
    return (
      process.env.EBARIMTSHINE_USERNAME ||
      process.env.ITC_USERNAME ||
      'Rooden_like@yahoo.com'
    );
  }

  private get password(): string {
    return (
      process.env.EBARIMTSHINE_PASSWORD ||
      process.env.ITC_PASSWORD ||
      'Br1stelback@'
    );
  }

  private get apiKey(): string {
    return (
      process.env.EBARIMTSHINE_X_API_KEY ||
      process.env.ITC_API_KEY ||
      'eaab09fdb83c4affc210b8fb96f9977db7978e8a'
    );
  }

  public lastAuthError: string = '';

  /**
   * Performs full password login against ITC Keycloak OAuth2 server.
   */
  private async passwordLogin(): Promise<TokenState | null> {
    try {
      this.lastAuthError = '';
      ebarimtLogger.info(
        { authUrl: this.authUrl, username: this.username },
        '🔑 [ITC AUTH] Performing password login...',
      );

      const body = new URLSearchParams({
        grant_type: 'password',
        client_id: this.clientId,
        username: this.username,
        password: this.password,
        scope: 'profile email',
      });

      const res = await fetch(this.authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(8_000),
      });

      const data = (await res.json().catch(() => null)) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (!res.ok || !data?.access_token) {
        const errMsg = data?.error_description || data?.error || `HTTP ${res.status}`;
        this.lastAuthError = errMsg;
        ebarimtLogger.error(
          { status: res.status, error: errMsg },
          '❌ [ITC AUTH] Password login failed',
        );
        return null;
      }

      const expiresInSec = data.expires_in || 28800;
      const state: TokenState = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + expiresInSec * 1000,
      };

      memoryToken = state;

      // Save to MongoDB for persistence across server restarts
      if (mongoose.connection.readyState === 1) {
        try {
          await ItcToken.updateOne(
            { scope: 'default' },
            {
              $set: {
                accessToken: state.accessToken,
                refreshToken: state.refreshToken,
                expiresAt: new Date(state.expiresAt),
              },
            },
            { upsert: true },
          );
        } catch (dbErr) {
          ebarimtLogger.warn({ err: (dbErr as Error).message }, '⚠️ [ITC AUTH] DB save error (non-critical)');
        }
      }

      ebarimtLogger.info(
        { expiresInSec },
        '✅ [ITC AUTH] Password login successful',
      );
      return state;
    } catch (err) {
      ebarimtLogger.error(
        { err: (err as Error).message },
        '❌ [ITC AUTH] Password login exception',
      );
      return null;
    }
  }

  /**
   * Uses existing refresh_token to acquire a fresh access_token.
   */
  private async refreshToken(refreshTokenValue: string): Promise<TokenState | null> {
    try {
      ebarimtLogger.info('🔄 [ITC AUTH] Refreshing access token via refresh_token...');

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        refresh_token: refreshTokenValue,
      });

      const res = await fetch(this.authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(8_000),
      });

      const data = (await res.json().catch(() => null)) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (!res.ok || !data?.access_token) {
        ebarimtLogger.warn(
          { status: res.status, error: data?.error_description || data?.error },
          '⚠️ [ITC AUTH] Refresh failed — will fall back to password login',
        );
        return null;
      }

      const expiresInSec = data.expires_in || 28800;
      const state: TokenState = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshTokenValue,
        expiresAt: Date.now() + expiresInSec * 1000,
      };

      memoryToken = state;

      if (mongoose.connection?.readyState === 1) {
        try {
          await ItcToken.updateOne(
            { scope: 'default' },
            {
              $set: {
                accessToken: state.accessToken,
                refreshToken: state.refreshToken,
                expiresAt: new Date(state.expiresAt),
              },
              $inc: { refreshCount: 1 },
            },
            { upsert: true },
          );
        } catch (dbErr) {
          ebarimtLogger.warn({ err: (dbErr as Error).message }, '⚠️ [ITC AUTH] DB save error (non-critical)');
        }
      }

      ebarimtLogger.info(
        { expiresInSec },
        '✅ [ITC AUTH] Token refreshed successfully',
      );
      return state;
    } catch (err) {
      ebarimtLogger.warn(
        { err: (err as Error).message },
        '⚠️ [ITC AUTH] Refresh exception — falling back to password login',
      );
      return null;
    }
  }

  /**
   * Retrieves an active OAuth access token with automatic 5-minute pre-expiry refresh.
   */
  async getAccessToken(): Promise<string | null> {
    // 0. Explicit static token override
    const directToken = process.env.EBARIMTSHINE_TOKEN || process.env.ITC_TOKEN || process.env.ITC_ACCESS_TOKEN;
    if (directToken?.trim()) {
      return directToken.trim();
    }

    const fiveMinBuffer = 5 * 60 * 1000;
    const now = Date.now();

    // 1. Check in-memory token
    if (memoryToken && memoryToken.accessToken && memoryToken.expiresAt > now + fiveMinBuffer) {
      return memoryToken.accessToken;
    }

    // 2. Check MongoDB persisted token
    if (!memoryToken && mongoose.connection?.readyState === 1) {
      try {
        const doc = await ItcToken.findOne({ scope: 'default' }).lean();
        if (doc && doc.accessToken && doc.expiresAt) {
          const docExpiresAt = new Date(doc.expiresAt).getTime();
          memoryToken = {
            accessToken: doc.accessToken,
            refreshToken: doc.refreshToken || undefined,
            expiresAt: docExpiresAt,
          };
          if (docExpiresAt > now + fiveMinBuffer) {
            return memoryToken.accessToken;
          }
        }
      } catch (err) {
        ebarimtLogger.warn({ err: (err as Error).message }, '⚠️ [ITC AUTH] DB token read error');
      }
    }

    // 3. Token expired or expiring within 5 min — attempt refresh
    if (memoryToken?.refreshToken) {
      const refreshed = await this.refreshToken(memoryToken.refreshToken);
      if (refreshed) {
        return refreshed.accessToken;
      }
    }

    // 4. Fall back to full password login
    const loggedIn = await this.passwordLogin();
    return loggedIn?.accessToken || null;
  }

  /**
   * API: api-1787241529220
   * POST /api/easy-register/rest/v1/getProfile
   * Checks whether a customerNo or phoneNum exists in E-Barimt.
   */
  async getProfile(query: {
    customerNo?: string;
    phoneNum?: string;
  }): Promise<{ valid: boolean; loginName?: string; email?: string; message: string }> {
    const cleanCustomer = query.customerNo?.trim();
    const cleanPhone = query.phoneNum?.trim();
    if (!cleanCustomer && !cleanPhone) {
      return { valid: false, message: 'Хэрэглэгчийн код эсвэл утасны дугаар хоосон байна' };
    }

    const token = await this.getAccessToken();
    if (!token) {
      return {
        valid: false,
        message: `ITC Auth алдаа: ${this.lastAuthError || 'Нэвтрэх токен авч чадсангүй'}`,
      };
    }

    try {
      const payload: Record<string, string> = {};
      if (cleanCustomer) payload.customerNo = cleanCustomer;
      if (cleanPhone) payload.phoneNum = cleanPhone;

      const res = await fetch(`${this.apiUrl}/api/easy-register/rest/v1/getProfile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-API-KEY': this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });

      if (res.ok) {
        const data = (await res.json().catch(() => null)) as ItcProfileResponse;
        if (data?.status === 200 && data.code?.toLowerCase() === 'success') {
          return {
            valid: true,
            loginName: data.loginName || cleanCustomer,
            email: data.email,
            message: `✓ E-Barimt бүртгэл баталгаажлаа (${data.loginName || cleanCustomer})`,
          };
        }
        return {
          valid: false,
          message: data?.msg || 'Ebarimt системд бүртгэлгүй код байна.',
        };
      }

      const errText = await res.text().catch(() => '');
      return {
        valid: false,
        message: errText || `ITC Серверээс алдаа буцаалаа (HTTP ${res.status})`,
      };
    } catch (err) {
      return {
        valid: false,
        message: `ITC холболтын алдаа: ${(err as Error).message}`,
      };
    }
  }

  /**
   * API: api-1787241649037
   * POST /api/easy-register/rest/v1/approveQr
   * Direct auto-registration of the receipt QR into the citizen's Ebarimt account.
   */
  async approveQr(
    customerNo: string,
    qrData: string,
  ): Promise<{ success: boolean; message: string }> {
    const cleanCustomer = customerNo.trim();
    const cleanQr = qrData.trim();
    if (!cleanCustomer || !cleanQr) {
      return { success: false, message: 'customerNo эсвэл qrData дутуу байна' };
    }

    const token = await this.getAccessToken();
    if (!token) {
      return { success: false, message: 'ITC token авч чадсангүй' };
    }

    try {
      const res = await fetch(`${this.apiUrl}/api/easy-register/rest/v1/approveQr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-API-KEY': this.apiKey,
        },
        body: JSON.stringify({
          customerNo: cleanCustomer,
          qrData: cleanQr,
        }),
        signal: AbortSignal.timeout(8_000),
      });

      const data = (await res.json().catch(() => null)) as ItcApproveQrResponse;
      if (res.ok && data?.status === 200 && data.code?.toUpperCase() === 'SUCCESS') {
        ebarimtLogger.info(
          { customerNo: cleanCustomer },
          '✅ [ITC-EASY-REGISTER] approveQr success — receipt registered directly to citizen ebarimt',
        );
        return {
          success: true,
          message: data.msg || 'Баримт хэрэглэгчийн И-Баримт дансанд шууд амжилттай бүртгэгдлээ.',
        };
      }

      ebarimtLogger.warn(
        { customerNo: cleanCustomer, response: data, status: res.status },
        '⚠️ [ITC-EASY-REGISTER] approveQr failed',
      );
      return {
        success: false,
        message: data?.msg || `approveQr амжилтгүй боллоо (${res.status})`,
      };
    } catch (err) {
      ebarimtLogger.error(
        { err: (err as Error).message, customerNo: cleanCustomer },
        '❌ [ITC-EASY-REGISTER] approveQr exception',
      );
      return {
        success: false,
        message: `approveQr алдаа: ${(err as Error).message}`,
      };
    }
  }

  /**
   * API: api-1787241300465
   * GET /api/easy-register/api/info/consumer/{identity}
   * Lookup citizen identity by national register number or civilId.
   */
  async getConsumerInfo(identity: string): Promise<ItcConsumerInfoResponse | null> {
    const clean = identity.trim();
    if (!clean) return null;

    const token = await this.getAccessToken();
    if (!token) return null;

    try {
      const res = await fetch(
        `${this.apiUrl}/api/easy-register/api/info/consumer/${encodeURIComponent(clean)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-API-KEY': this.apiKey,
          },
          signal: AbortSignal.timeout(5_000),
        },
      );

      if (res.ok) {
        return (await res.json().catch(() => null)) as ItcConsumerInfoResponse;
      }
    } catch (err) {
      ebarimtLogger.warn(
        { err: (err as Error).message, identity: clean },
        '⚠️ [ITC-EASY-REGISTER] getConsumerInfo exception',
      );
    }
    return null;
  }
}

export const itcEasyRegisterService = new ItcEasyRegisterService();
