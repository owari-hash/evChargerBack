import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { DriverError, driverLogger, guard, HOUR, MINUTE, parseQuery, route } from '../http';

/**
 * Google Maps for the driver app: map tiles with the live traffic layer, and
 * traffic-aware routes whose stretches are marked normal / slow / jam so the
 * app can paint them green / orange / red like Google Maps.
 *
 * Both are optional. Without their keys these answer 503 and the app keeps
 * OpenStreetMap tiles and the OSRM router, exactly as before.
 */
export const mapsRoutes = Router();

const notConfigured = () => new DriverError(503, 'Google Maps тохируулаагүй байна');

// ---------------------------------------------------------------------------
// Tiles: GET /app-api/maps/tiles?theme=dark
// ---------------------------------------------------------------------------

/** Night styling for the dark theme, close to the app's emerald-black palette. */
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0b1512' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8fa79c' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#050c0a' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1a2a24' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#22362e' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2b4439' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#06231c' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#0f1c18' }] },
];

interface TileSession {
  session: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** One session per theme, reused until a day before it expires (they last ~2 weeks). */
const tileSessions = new Map<'light' | 'dark', TileSession>();

async function tileSession(theme: 'light' | 'dark', key: string): Promise<TileSession> {
  const cached = tileSessions.get(theme);
  if (cached && cached.expiresAt - Date.now() > 24 * HOUR) return cached;

  const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mapType: 'roadmap',
      language: 'mn-MN',
      region: 'MN',
      // Live traffic drawn on the road tiles.
      layerTypes: ['layerTraffic'],
      ...(theme === 'dark' ? { styles: DARK_STYLE } : {}),
    }),
  });
  if (!res.ok) {
    driverLogger.warn({ status: res.status, body: await res.text().catch(() => '') }, 'map tiles session failed');
    throw new DriverError(502, 'Газрын зургийн үйлчилгээ түр ажиллахгүй байна');
  }
  const body = (await res.json()) as { session?: string; expiry?: string };
  if (!body.session) throw new DriverError(502, 'Газрын зургийн үйлчилгээ түр ажиллахгүй байна');

  const next: TileSession = {
    session: body.session,
    expiresAt: body.expiry ? Number(body.expiry) * 1000 : Date.now() + 7 * 24 * HOUR,
  };
  tileSessions.set(theme, next);
  return next;
}

mapsRoutes.get(
  '/tiles',
  route(async (req) => {
    const key = env.GOOGLE_MAP_TILES_API_KEY;
    if (!key) throw notConfigured();
    guard(req, 'maps-tiles', 120, HOUR);
    const { theme } = parseQuery(req, z.object({ theme: z.enum(['light', 'dark']).default('light') }));
    const s = await tileSession(theme, key);
    return {
      urlTemplate: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(
        s.session,
      )}&key=${encodeURIComponent(key)}`,
      expiresAt: new Date(s.expiresAt).toISOString(),
      attribution: 'Google',
    };
  }),
);

// ---------------------------------------------------------------------------
// Route: GET /app-api/maps/route?from=lat,lng&to=lat,lng
// ---------------------------------------------------------------------------

const latLng = z
  .string()
  .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, 'lat,lng')
  .transform((v) => {
    const [lat, lng] = v.split(',').map(Number);
    return { latitude: lat, longitude: lng };
  })
  .refine((p) => Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180, 'lat,lng');

/** Google's encoded polyline format → [lat, lng] pairs. */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

type Speed = 'NORMAL' | 'SLOW' | 'TRAFFIC_JAM';

interface RoutesApiResponse {
  routes?: {
    distanceMeters?: number;
    duration?: string;
    staticDuration?: string;
    polyline?: { encodedPolyline?: string };
    travelAdvisory?: {
      speedReadingIntervals?: { startPolylinePointIndex?: number; endPolylinePointIndex?: number; speed?: Speed }[];
    };
  }[];
}

const seconds = (d?: string) => (d ? Math.round(Number.parseFloat(d)) : 0);

mapsRoutes.get(
  '/route',
  route(async (req) => {
    const key = env.GOOGLE_ROUTES_API_KEY;
    if (!key) throw notConfigured();
    // Route requests are billed per call; the app asks once per trip and on
    // big detours, so this only stops runaway loops.
    guard(req, 'maps-route', 30, 10 * MINUTE);
    const { from, to } = parseQuery(req, z.object({ from: latLng, to: latLng }));

    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': [
          'routes.distanceMeters',
          'routes.duration',
          'routes.staticDuration',
          'routes.polyline.encodedPolyline',
          'routes.travelAdvisory.speedReadingIntervals',
        ].join(','),
      },
      body: JSON.stringify({
        origin: { location: { latLng: from } },
        destination: { location: { latLng: to } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        extraComputations: ['TRAFFIC_ON_POLYLINE'],
        languageCode: 'mn',
        units: 'METRIC',
      }),
    });
    if (!res.ok) {
      driverLogger.warn({ status: res.status, body: await res.text().catch(() => '') }, 'routes api failed');
      throw new DriverError(502, 'Чиглэл тооцоолох үйлчилгээ түр ажиллахгүй байна');
    }
    const first = ((await res.json()) as RoutesApiResponse).routes?.[0];
    const encoded = first?.polyline?.encodedPolyline;
    if (!first || !encoded) throw new DriverError(404, 'Чиглэл олдсонгүй');

    const points = decodePolyline(encoded);
    return {
      points,
      distanceMeters: first.distanceMeters ?? 0,
      /** With current traffic. */
      durationSeconds: seconds(first.duration),
      /** Without traffic, so the app can say how much the traffic adds. */
      staticDurationSeconds: seconds(first.staticDuration),
      // Proto3 leaves out zero values, so a missing start index means 0.
      traffic: (first.travelAdvisory?.speedReadingIntervals ?? []).map((i) => ({
        start: i.startPolylinePointIndex ?? 0,
        end: i.endPolylinePointIndex ?? points.length - 1,
        speed: i.speed ?? 'NORMAL',
      })),
    };
  }),
);
