/**
 * Read-only data the assistant can look up for the *signed-in* driver asking
 * it a question — their own wallet, their own charging history, live station
 * status. Nothing here ever reaches another driver's data: every tool is
 * scoped to the `StoredUser` resolved from the request's own session cookie.
 *
 * Signed-out visitors still get the assistant, just without these — the tool
 * list below is omitted entirely when there is no user (see assistant.ts).
 */
import { getStation, listSessionsForIdTag, listStations } from './charging';
import { getWallet } from './wallet';
import type { StoredUser } from './store';
import type { StationQuery } from './validation';

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export const ASSISTANT_TOOLS: ToolDef[] = [
  {
    name: 'get_wallet_balance',
    description: "Нэвтэрсэн жолоочийн хэтэвчний одоогийн үлдэгдлийг буцаана (төгрөгөөр).",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_recent_sessions',
    description:
      'Нэвтэрсэн жолоочийн сүүлийн цэнэглэлтүүдийг буцаана — станц, эрчим хүч (kWh), үнэ, огноо.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Хэдэн цэнэглэлт авах вэ (анхдагч 5, дээд тал нь 20).' },
      },
      required: [],
    },
  },
  {
    name: 'get_active_session',
    description: 'Нэвтэрсэн жолоочийн яг одоо үргэлжилж буй цэнэглэлт байгаа эсэхийг шалгана.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_ebarimt_status',
    description:
      'Сүүлийн цэнэглэлтүүдийн е-баримт авсан эсэх, авсан бол дүн/лотерейн дугаарыг буцаана.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Хэдэн сүүлийн цэнэглэлтийг шалгах вэ (анхдагч 5).' },
      },
      required: [],
    },
  },
  {
    name: 'find_station',
    description:
      'Нэр эсвэл байршлаар станц хайж, түүний онлайн эсэх, сул залгуурын тоо, тарифыг буцаана.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Станцын нэр эсвэл хэсэг нэр.' },
      },
      required: ['query'],
    },
  },
];

/** Keeps a tool's JSON result bounded — a chat round-trip is not a reporting
 * endpoint, and a huge payload only wastes model context. */
const MAX_RESULT_CHARS = 4000;

function clip(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json.length <= MAX_RESULT_CHARS) return value;
  return { note: 'Хариу хэт урт тул товчлов.', truncated: true };
}

/** Runs one tool by name for `user` (null = signed-out, no tools offered). */
export async function runAssistantTool(
  user: StoredUser | null,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!user) return { error: 'Нэвтрээгүй тул энэ мэдээллийг харах боломжгүй.' };

  try {
    switch (name) {
      case 'get_wallet_balance': {
        const wallet = await getWallet(user.id);
        return clip({
          balance: wallet.balance ?? 0,
          currency: wallet.currency ?? 'MNT',
        });
      }
      case 'get_recent_sessions': {
        const limitRaw = Number(args.limit);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 20) : 5;
        const sessions = await listSessionsForIdTag(user.idTag, limit);
        return clip(
          sessions.map((s) => ({
            station: s.stationName,
            status: s.status,
            energyKwh: s.energyKwh,
            cost: s.cost,
            startedAt: s.startTimestamp,
            stoppedAt: s.stopTimestamp,
          })),
        );
      }
      case 'get_active_session': {
        const sessions = await listSessionsForIdTag(user.idTag, 5);
        const active = sessions.find((s) => s.status === 'Active');
        return clip(
          active
            ? {
                active: true,
                station: active.stationName,
                energyKwh: active.energyKwh,
                startedAt: active.startTimestamp,
              }
            : { active: false },
        );
      }
      case 'get_ebarimt_status': {
        const limitRaw = Number(args.limit);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 20) : 5;
        const sessions = await listSessionsForIdTag(user.idTag, limit);
        return clip(
          sessions
            .filter((s) => s.status === 'Completed' || s.status === 'Refunded')
            .map((s) => ({
              station: s.stationName,
              stoppedAt: s.stopTimestamp,
              ebarimtStatus: s.ebarimt?.status ?? 'NONE',
              totalAmount: s.ebarimt?.totalAmount,
              lottery: s.ebarimt?.lottery,
            })),
        );
      }
      case 'find_station': {
        const query = typeof args.query === 'string' ? args.query.trim().slice(0, 120) : '';
        if (!query) return { error: 'Станцын нэрээ дурдана уу.' };
        const stationQuery: StationQuery = { search: query, status: 'all', limit: 200 };
        const { stations } = await listStations(stationQuery);
        if (stations.length === 0) {
          const byId = await getStation(query);
          if (!byId) return { error: 'Ийм станц олдсонгүй.' };
          return clip([summariseStation(byId)]);
        }
        return clip(stations.slice(0, 5).map(summariseStation));
      }
      default:
        return { error: `Үл мэдэгдэх хэрэгсэл: ${name}` };
    }
  } catch (err) {
    return { error: `Мэдээлэл татахад алдаа гарлаа: ${(err as Error).message}`.slice(0, 300) };
  }
}

function summariseStation(station: {
  name?: string;
  isOnline?: boolean;
  availableConnectors?: number;
  totalConnectors?: number;
  tariffPerKwh?: number;
}): Record<string, unknown> {
  return {
    name: station.name,
    online: station.isOnline ?? false,
    availableConnectors: station.availableConnectors ?? 0,
    totalConnectors: station.totalConnectors ?? 0,
    tariffPerKwh: station.tariffPerKwh ?? null,
  };
}
