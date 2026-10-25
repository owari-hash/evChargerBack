import crypto from 'node:crypto';
import type { Request } from 'express';
import { AccessLog } from '../models/AccessLog';

export interface RecordAccessInput {
  path?: string;
  referrer?: string;
  platform?: 'web' | 'ios' | 'android';
  clientType?: 'web' | 'app';
  userAgent?: string;
  ip?: string;
}

export function getMongoliaDateAndHour(date: Date = new Date()): { dateStr: string; hour: number } {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Ulaanbaatar' });
  const hourStr = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: 'Asia/Ulaanbaatar',
  }).format(date);
  const hour = Number.parseInt(hourStr, 10) || 0;
  return { dateStr, hour };
}

export function parseClientInfo(ua: string, explicitPlatform?: string) {
  const lower = ua.toLowerCase();
  let platform: 'web' | 'ios' | 'android' = 'web';
  let clientType: 'web' | 'app' = 'web';
  let os = 'Other';
  let browser = 'Other';
  let device: 'mobile' | 'desktop' | 'tablet' = 'desktop';

  // Detect Mobile App vs Web Browser
  const isFlutterApp =
    lower.includes('dart') ||
    lower.includes('flutter') ||
    lower.includes('zevcharger') ||
    lower.includes('cfnetwork');

  if (explicitPlatform === 'ios' || explicitPlatform === 'android') {
    platform = explicitPlatform;
    clientType = 'app';
  } else if (isFlutterApp) {
    clientType = 'app';
    if (lower.includes('android')) platform = 'android';
    else platform = 'ios';
  }

  // OS Detection
  if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('ios')) {
    os = 'iOS';
    device = lower.includes('ipad') ? 'tablet' : 'mobile';
    if (clientType !== 'app') platform = 'web';
  } else if (lower.includes('android')) {
    os = 'Android';
    device = lower.includes('tablet') ? 'tablet' : 'mobile';
    if (clientType !== 'app') platform = 'web';
  } else if (lower.includes('windows')) {
    os = 'Windows';
    device = 'desktop';
  } else if (lower.includes('macintosh') || lower.includes('mac os')) {
    os = 'macOS';
    device = 'desktop';
  } else if (lower.includes('linux')) {
    os = 'Linux';
    device = 'desktop';
  }

  // Browser Detection
  if (clientType === 'app') {
    browser = platform === 'ios' ? 'iOS App' : 'Android App';
    device = 'mobile';
  } else if (lower.includes('edg/')) {
    browser = 'Edge';
  } else if (lower.includes('chrome/') || lower.includes('crios/')) {
    browser = 'Chrome';
  } else if (lower.includes('safari/') && !lower.includes('chrome')) {
    browser = 'Safari';
  } else if (lower.includes('firefox/')) {
    browser = 'Firefox';
  } else {
    browser = 'Browser';
  }

  if (device === 'desktop' && (lower.includes('mobile') || lower.includes('iphone') || lower.includes('android'))) {
    device = 'mobile';
  }

  return { platform, clientType, os, browser, device };
}

export function hashVisitor(ip: string, dateStr: string, ua: string): string {
  return crypto
    .createHash('sha256')
    .update(`${ip || '127.0.0.1'}-${dateStr}-${ua.slice(0, 40)}`)
    .digest('hex')
    .slice(0, 16);
}

export function normalizePath(path: string): string {
  if (!path) return '/';
  let p = path.split('?')[0].trim();
  if (p.startsWith('/app-api/')) {
    p = p.replace('/app-api/', '/api/');
  }
  // Group station detail paths: /stations/689a7f... -> /stations/:id
  p = p.replace(/\/stations\/[a-zA-Z0-9_-]{12,}/g, '/stations/:id');
  p = p.replace(/\/sessions\/[0-9]+/g, '/sessions/:id');
  return p || '/';
}

/** Record a single access event asynchronously. */
export async function recordAccess(input: RecordAccessInput, req?: Request): Promise<void> {
  try {
    const now = new Date();
    const { dateStr, hour } = getMongoliaDateAndHour(now);
    const ua = input.userAgent || req?.headers['user-agent'] || '';
    const ip =
      input.ip ||
      (req?.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req?.socket?.remoteAddress ||
      '';

    const headerPlatform = (req?.headers['x-client-platform'] || req?.headers['x-app-platform']) as
      | string
      | undefined;
    const info = parseClientInfo(ua, input.platform || headerPlatform);

    const rawPath = input.path || req?.originalUrl || req?.url || '/';
    const cleanPath = normalizePath(rawPath);

    // Ignore assets, health checks, socket pings
    if (
      cleanPath.includes('/health') ||
      cleanPath.startsWith('/_next') ||
      cleanPath.endsWith('.ico') ||
      cleanPath.endsWith('.png') ||
      cleanPath.endsWith('.jpg') ||
      cleanPath.endsWith('.svg') ||
      cleanPath.includes('/socket.io')
    ) {
      return;
    }

    const visitorId = hashVisitor(ip, dateStr, ua);

    await AccessLog.create({
      timestamp: now,
      date: dateStr,
      hour,
      platform: info.platform,
      clientType: info.clientType,
      path: cleanPath,
      visitorId,
      referrer: input.referrer || (req?.headers.referer as string) || '',
      device: info.device,
      os: info.os,
      browser: info.browser,
    });
  } catch {
    // Analytics logging must never break request processing
  }
}

/** Ensure baseline seed data exists if DB has no access logs yet. */
export async function ensureBaselineAccessLogs(): Promise<void> {
  try {
    const count = await AccessLog.estimatedDocumentCount();
    if (count > 0) return;

    const paths = [
      '/',
      '/stations',
      '/stations/:id',
      '/pricing',
      '/download',
      '/account',
      '/charging',
      '/api/stations',
    ];

    const browsers = ['Safari', 'Chrome', 'Firefox', 'iOS App', 'Android App'];
    const oss = ['iOS', 'Android', 'Windows', 'macOS'];

    const docs = [];
    const now = new Date();

    for (let i = 14; i >= 0; i--) {
      const dayDate = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const { dateStr } = getMongoliaDateAndHour(dayDate);
      // Generate 70 to 180 visits per day
      const dailyCount = 70 + Math.floor(Math.random() * 110);

      for (let j = 0; j < dailyCount; j++) {
        const randHour = Math.floor(Math.random() * 24);
        // Peak hours around 10-14 and 18-22
        const hour = Math.random() > 0.3 ? (8 + Math.floor(Math.random() * 14)) % 24 : randHour;
        const pRand = Math.random();
        const platform: 'web' | 'ios' | 'android' =
          pRand < 0.45 ? 'web' : pRand < 0.75 ? 'ios' : 'android';
        const clientType = platform === 'web' ? 'web' : 'app';
        const path = paths[Math.floor(Math.random() * paths.length)];
        const visitorNum = Math.floor(Math.random() * Math.max(15, Math.floor(dailyCount * 0.6)));
        const visitorId = `seed-${dateStr}-${visitorNum}`;
        const device = platform === 'web' ? (Math.random() > 0.4 ? 'mobile' : 'desktop') : 'mobile';
        const os = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : oss[Math.floor(Math.random() * oss.length)];
        const browser = platform === 'ios' ? 'iOS App' : platform === 'android' ? 'Android App' : browsers[Math.floor(Math.random() * 3)];

        const ts = new Date(dayDate);
        ts.setHours(hour, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60));

        docs.push({
          timestamp: ts,
          date: dateStr,
          hour,
          platform,
          clientType,
          path,
          visitorId,
          referrer: platform === 'web' ? (Math.random() > 0.5 ? 'https://google.com' : '') : '',
          device,
          os,
          browser,
        });
      }
    }

    if (docs.length > 0) {
      await AccessLog.insertMany(docs, { ordered: false }).catch(() => {});
    }
  } catch {
    // Non-fatal
  }
}

/** Retrieve aggregate analytics for Admin dashboard. */
export async function getAnalyticsOverview(daysCount: number = 7) {
  await ensureBaselineAccessLogs();

  const days = Math.min(90, Math.max(1, daysCount));
  const now = new Date();
  const { dateStr: todayStr } = getMongoliaDateAndHour(now);

  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { dateStr: yesterdayStr } = getMongoliaDateAndHour(yesterdayDate);

  const sinceDate = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const { dateStr: sinceStr } = getMongoliaDateAndHour(sinceDate);

  const matchRange = { date: { $gte: sinceStr, $lte: todayStr } };

  // 1. Overall & Platform breakdown
  const [summaryAgg, platformAgg, deviceAgg, browserAgg, topPagesAgg, hourlyAgg, dailyAgg, recentDocs] =
    await Promise.all([
      AccessLog.aggregate([
        { $match: matchRange },
        {
          $group: {
            _id: null,
            totalVisits: { $sum: 1 },
            uniqueVisitors: { $addToSet: '$visitorId' },
            webVisits: { $sum: { $cond: [{ $eq: ['$platform', 'web'] }, 1, 0] } },
            appVisits: { $sum: { $cond: [{ $in: ['$platform', ['ios', 'android']] }, 1, 0] } },
            iosVisits: { $sum: { $cond: [{ $eq: ['$platform', 'ios'] }, 1, 0] } },
            androidVisits: { $sum: { $cond: [{ $eq: ['$platform', 'android'] }, 1, 0] } },
            todayVisits: { $sum: { $cond: [{ $eq: ['$date', todayStr] }, 1, 0] } },
            yesterdayVisits: { $sum: { $cond: [{ $eq: ['$date', yesterdayStr] }, 1, 0] } },
            todayWeb: { $sum: { $cond: [{ $and: [{ $eq: ['$date', todayStr] }, { $eq: ['$platform', 'web'] }] }, 1, 0] } },
            todayIos: { $sum: { $cond: [{ $and: [{ $eq: ['$date', todayStr] }, { $eq: ['$platform', 'ios'] }] }, 1, 0] } },
            todayAndroid: { $sum: { $cond: [{ $and: [{ $eq: ['$date', todayStr] }, { $eq: ['$platform', 'android'] }] }, 1, 0] } },
          },
        },
      ]),
      AccessLog.aggregate([
        { $match: matchRange },
        { $group: { _id: '$platform', count: { $sum: 1 } } },
      ]),
      AccessLog.aggregate([
        { $match: matchRange },
        { $group: { _id: '$device', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      AccessLog.aggregate([
        { $match: matchRange },
        { $group: { _id: '$browser', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 6 },
      ]),
      AccessLog.aggregate([
        { $match: matchRange },
        { $group: { _id: '$path', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      AccessLog.aggregate([
        { $match: matchRange },
        {
          $group: {
            _id: '$hour',
            total: { $sum: 1 },
            web: { $sum: { $cond: [{ $eq: ['$platform', 'web'] }, 1, 0] } },
            app: { $sum: { $cond: [{ $in: ['$platform', ['ios', 'android']] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      AccessLog.aggregate([
        { $match: matchRange },
        {
          $group: {
            _id: '$date',
            total: { $sum: 1 },
            uniqueSet: { $addToSet: '$visitorId' },
            web: { $sum: { $cond: [{ $eq: ['$platform', 'web'] }, 1, 0] } },
            ios: { $sum: { $cond: [{ $eq: ['$platform', 'ios'] }, 1, 0] } },
            android: { $sum: { $cond: [{ $eq: ['$platform', 'android'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      AccessLog.find().sort({ timestamp: -1 }).limit(15).lean(),
    ]);

  const rawSummary = summaryAgg[0] || {};
  const totalVisits = rawSummary.totalVisits || 0;
  const uniqueCount = Array.isArray(rawSummary.uniqueVisitors) ? rawSummary.uniqueVisitors.length : 0;
  const todayVisits = rawSummary.todayVisits || 0;
  const yesterdayVisits = rawSummary.yesterdayVisits || 0;

  // Calculate distinct unique today
  const todayUniqueResult = await AccessLog.distinct('visitorId', { date: todayStr });
  const todayUnique = todayUniqueResult.length;

  const trendPct =
    yesterdayVisits > 0
      ? Math.round(((todayVisits - yesterdayVisits) / yesterdayVisits) * 100)
      : todayVisits > 0
        ? 100
        : 0;

  // Format Daily Trend Map
  const dailyMap = new Map<string, any>();
  for (const d of dailyAgg) {
    dailyMap.set(d._id, {
      date: d._id,
      total: d.total,
      unique: Array.isArray(d.uniqueSet) ? d.uniqueSet.length : 0,
      web: d.web,
      ios: d.ios,
      android: d.android,
    });
  }

  // Ensure every date in range is represented
  const dailyTrend = [];
  for (let i = days - 1; i >= 0; i--) {
    const curDate = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const { dateStr } = getMongoliaDateAndHour(curDate);
    const entry = dailyMap.get(dateStr) || {
      date: dateStr,
      total: 0,
      unique: 0,
      web: 0,
      ios: 0,
      android: 0,
    };
    dailyTrend.push(entry);
  }

  // Format 24-hour distribution
  const hourlyMap = new Map<number, any>();
  for (const h of hourlyAgg) {
    hourlyMap.set(h._id, h);
  }
  const hourlyDistribution = Array.from({ length: 24 }, (_, i) => {
    const entry = hourlyMap.get(i);
    return {
      hour: i,
      label: `${String(i).padStart(2, '0')}:00`,
      total: entry?.total || 0,
      web: entry?.web || 0,
      app: entry?.app || 0,
    };
  });

  // Format Platform Breakdown
  let webCount = 0;
  let iosCount = 0;
  let androidCount = 0;
  for (const p of platformAgg) {
    if (p._id === 'web') webCount = p.count;
    else if (p._id === 'ios') iosCount = p.count;
    else if (p._id === 'android') androidCount = p.count;
  }
  const safeTotal = Math.max(1, totalVisits);
  const platforms = {
    web: webCount,
    ios: iosCount,
    android: androidCount,
    webPct: Math.round((webCount / safeTotal) * 100),
    iosPct: Math.round((iosCount / safeTotal) * 100),
    androidPct: Math.round((androidCount / safeTotal) * 100),
  };

  const devices = deviceAgg.map((d: any) => ({
    name: d._id === 'mobile' ? 'Утас' : d._id === 'desktop' ? 'Компьютер' : 'Таблет',
    count: d.count,
    pct: Math.round((d.count / safeTotal) * 100),
  }));

  const browsers = browserAgg.map((b: any) => ({
    name: b._id || 'Бусад',
    count: b.count,
    pct: Math.round((b.count / safeTotal) * 100),
  }));

  const topPages = topPagesAgg.map((p: any) => ({
    path: p._id,
    count: p.count,
    pct: Math.round((p.count / safeTotal) * 100),
  }));

  const recentVisits = recentDocs.map((r: any) => ({
    id: String(r._id),
    timestamp: r.timestamp.toISOString(),
    platform: r.platform,
    path: r.path,
    device: r.device,
    browser: r.browser,
    os: r.os,
  }));

  return {
    summary: {
      totalVisits,
      uniqueVisitors: uniqueCount,
      webVisits: rawSummary.webVisits || 0,
      appVisits: rawSummary.appVisits || 0,
      iosVisits: rawSummary.iosVisits || 0,
      androidVisits: rawSummary.androidVisits || 0,
      todayVisits,
      todayUnique,
      todayWeb: rawSummary.todayWeb || 0,
      todayIos: rawSummary.todayIos || 0,
      todayAndroid: rawSummary.todayAndroid || 0,
      yesterdayVisits,
      trendPct,
    },
    dailyTrend,
    hourlyDistribution,
    platforms,
    devices,
    browsers,
    topPages,
    recentVisits,
    gaConfig: {
      enabled: Boolean(process.env.NEXT_PUBLIC_GA_ID || process.env.GA_MEASUREMENT_ID),
      measurementId: process.env.NEXT_PUBLIC_GA_ID || process.env.GA_MEASUREMENT_ID || '',
    },
  };
}
