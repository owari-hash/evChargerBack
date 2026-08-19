/**
 * Minimal OCPP 1.6J charge point simulator, for smoke-testing the Central System.
 *
 *   npm run simulator -- --id CP-DEMO-001 --url ws://localhost:3000/ocpp --key <AuthorizationKey>
 *   npm run simulator -- --id CP-DEMO-001 --url wss://eplug.mn/ocpp --key <AuthorizationKey>
 *
 * It boots, sends StatusNotification, starts a transaction, streams MeterValues
 * for a while, then stops. It also answers the Central System's commands.
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

interface Args {
  id: string;
  url: string;
  key?: string;
  idTag: string;
  connector: number;
  seconds: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    id: get('id', 'CP-SIM-001')!,
    url: get('url', 'ws://localhost:3000/ocpp')!,
    key: get('key'),
    idTag: get('idTag', 'TAG-0001')!,
    connector: Number(get('connector', '1')),
    seconds: Number(get('seconds', '60')),
  };
}

const args = parseArgs();
const pending = new Map<string, (payload: unknown) => void>();

const headers: Record<string, string> = {};
if (args.key) {
  headers.Authorization =
    'Basic ' + Buffer.from(`${args.id}:${args.key}`).toString('base64');
}

const ws = new WebSocket(`${args.url}/${encodeURIComponent(args.id)}`, ['ocpp1.6'], { headers });

function call<T = Record<string, unknown>>(action: string, payload: unknown): Promise<T> {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve as (p: unknown) => void);
    ws.send(JSON.stringify([2, id, action, payload]));
    console.log(`-> ${action}`, JSON.stringify(payload));
  });
}

function reply(uniqueId: string, payload: unknown): void {
  ws.send(JSON.stringify([3, uniqueId, payload]));
}

/** Answers to Central System commands. Enough to exercise the REST endpoints. */
function handleCall(action: string, payload: Record<string, unknown>): unknown {
  switch (action) {
    case 'GetConfiguration':
      return {
        configurationKey: [
          { key: 'HeartbeatInterval', readonly: false, value: '300' },
          { key: 'NumberOfConnectors', readonly: true, value: '2' },
          { key: 'SecurityProfile', readonly: false, value: '1' },
          { key: 'CpoName', readonly: false, value: 'DemoCPO' },
          { key: 'MeterValueSampleInterval', readonly: false, value: '30' },
        ],
        unknownKey: [],
      };
    case 'ChangeConfiguration':
      return { status: 'Accepted' };
    case 'GetLocalListVersion':
      return { listVersion: 0 };
    case 'SendLocalList':
      return { status: 'Accepted' };
    case 'TriggerMessage':
    case 'ExtendedTriggerMessage':
      return { status: 'Accepted' };
    case 'ReserveNow':
      return { status: 'Accepted' };
    case 'SetChargingProfile':
      return { status: 'Accepted' };
    case 'GetCompositeSchedule':
      return { status: 'Rejected' };
    case 'GetInstalledCertificateIds':
      return { status: 'NotFound' };
    case 'InstallCertificate':
    case 'CertificateSigned':
      return { status: 'Accepted' };
    case 'GetLog':
      return { status: 'Accepted', filename: 'security.log' };
    case 'GetDiagnostics':
      return { fileName: 'diagnostics.zip' };
    case 'UnlockConnector':
      return { status: 'Unlocked' };
    case 'RemoteStopTransaction':
      console.log('   (simulator will stop the running transaction)');
      stopNow = true;
      return { status: 'Accepted' };
    case 'DataTransfer':
      return { status: 'UnknownVendorId' };
    default:
      if (typeof payload === 'object') {
        return { status: 'Accepted' };
      }
      return {};
  }
}

let stopNow = false;

ws.on('open', () => {
  console.log(`connected as ${args.id}`);
  void run();
});

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString()) as unknown[];
  const [type, id] = frame as [number, string];
  if (type === 3) {
    console.log(`<- result`, JSON.stringify(frame[2]));
    pending.get(id)?.(frame[2]);
    pending.delete(id);
  } else if (type === 4) {
    console.error(`<- CALLERROR`, frame[2], frame[3]);
    pending.get(id)?.({});
    pending.delete(id);
  } else if (type === 2) {
    const action = frame[2] as string;
    console.log(`<- ${action}`, JSON.stringify(frame[3]));
    reply(id, handleCall(action, (frame[3] ?? {}) as Record<string, unknown>));
  }
});

ws.on('error', (err) => console.error('socket error:', err.message));
ws.on('close', (code, reason) =>
  console.log(`closed (${code}) ${reason.toString()}`),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<void> {
  const boot = await call<{ status: string; interval: number }>('BootNotification', {
    chargePointVendor: 'SimVendor',
    chargePointModel: 'SimModel-22kW',
    chargePointSerialNumber: 'SN-' + args.id,
    firmwareVersion: '1.0.0',
  });
  if (boot.status !== 'Accepted') {
    console.error('boot rejected:', boot.status);
    return;
  }

  const heartbeat = setInterval(() => void call('Heartbeat', {}), (boot.interval || 300) * 1000);
  heartbeat.unref();

  await call('StatusNotification', {
    connectorId: 0,
    errorCode: 'NoError',
    status: 'Available',
    timestamp: new Date().toISOString(),
  });
  await call('StatusNotification', {
    connectorId: args.connector,
    errorCode: 'NoError',
    status: 'Available',
    timestamp: new Date().toISOString(),
  });

  const auth = await call<{ idTagInfo: { status: string } }>('Authorize', { idTag: args.idTag });
  console.log('authorize ->', auth.idTagInfo.status);
  if (auth.idTagInfo.status !== 'Accepted') return;

  await call('StatusNotification', {
    connectorId: args.connector,
    errorCode: 'NoError',
    status: 'Preparing',
    timestamp: new Date().toISOString(),
  });

  let meterWh = 1_000_000;
  const start = await call<{ transactionId: number }>('StartTransaction', {
    connectorId: args.connector,
    idTag: args.idTag,
    meterStart: meterWh,
    timestamp: new Date().toISOString(),
  });
  const transactionId = start.transactionId;

  await call('StatusNotification', {
    connectorId: args.connector,
    errorCode: 'NoError',
    status: 'Charging',
    timestamp: new Date().toISOString(),
  });

  const steps = Math.max(1, Math.floor(args.seconds / 5));
  for (let i = 0; i < steps && !stopNow; i++) {
    await sleep(5000);
    meterWh += 30; // ~22 kW for 5 s
    await call('MeterValues', {
      connectorId: args.connector,
      transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: String(meterWh),
              measurand: 'Energy.Active.Import.Register',
              unit: 'Wh',
              context: 'Sample.Periodic',
            },
            { value: '22000', measurand: 'Power.Active.Import', unit: 'W' },
            { value: String(20 + i), measurand: 'SoC', unit: 'Percent' },
          ],
        },
      ],
    });
  }

  await call('StopTransaction', {
    transactionId,
    idTag: args.idTag,
    meterStop: meterWh,
    timestamp: new Date().toISOString(),
    reason: stopNow ? 'Remote' : 'Local',
  });

  await call('StatusNotification', {
    connectorId: args.connector,
    errorCode: 'NoError',
    status: 'Available',
    timestamp: new Date().toISOString(),
  });

  await call('SecurityEventNotification', {
    type: 'StartupOfTheDevice',
    timestamp: new Date().toISOString(),
    techInfo: 'simulator run complete',
  });

  console.log('simulation complete; keeping the connection open (Ctrl+C to exit)');
}
