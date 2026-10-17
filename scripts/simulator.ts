/**
 * Advanced OCPP 1.6J Charge Point Simulator
 *
 * Supports:
 *  - Vehicle Info & Car presets (BYD Atto 3, VW ID.4, Tesla Model Y, Custom VIN)
 *  - Automatic or interactive GB/T DataTransfer handshake (BRM / VIN / Battery kWh)
 *  - Realistic Charging Curves & MeterValues (kW, kWh, battery SoC % tapering)
 *  - Interactive Keyboard Controls ([p] Plug In, [s] Start, [m] Meter, [f] Fault, [x] Stop)
 *  - Heavy Load / Fleet Stress Testing (--fleet <count>)
 *
 * Usage:
 *   npm run simulator -- --id CP-SIM-001 --car byd
 *   npm run simulator -- --id CP-SIM-001 --car tesla --vin 5YJ3E1EB8LF123456
 *   npm run simulator -- --fleet 20 --url ws://localhost:3000/ocpp
 */
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import WebSocket from 'ws';

interface CarPreset {
  name: string;
  vin: string;
  batteryKwh: number;
  maxPowerKw: number;
  initialSoc: number;
}

const CAR_PRESETS: Record<string, CarPreset> = {
  byd: {
    name: 'BYD Atto 3',
    vin: 'LZY1234567890ABCD',
    batteryKwh: 60.48,
    maxPowerKw: 88,
    initialSoc: 25,
  },
  vw: {
    name: 'VW ID.4 Prime',
    vin: 'LFV2A21K2N0123456',
    batteryKwh: 84.0,
    maxPowerKw: 100,
    initialSoc: 18,
  },
  tesla: {
    name: 'Tesla Model Y Long Range',
    vin: '5YJ3E1EB8LF123456',
    batteryKwh: 75.0,
    maxPowerKw: 120,
    initialSoc: 30,
  },
  leaf: {
    name: 'Nissan Leaf e+',
    vin: '1N4AZ1CP8LC123456',
    batteryKwh: 62.0,
    maxPowerKw: 50,
    initialSoc: 40,
  },
};

interface Args {
  id: string;
  url: string;
  key?: string;
  idTag: string;
  connector: number;
  seconds: number;
  carKey: string;
  vin?: string;
  model?: string;
  battery?: number;
  soc?: number;
  power?: number;
  fleet?: number;
  auto: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const has = (name: string) => argv.includes(`--${name}`);

  return {
    id: get('id', 'CP-SIM-001')!,
    url: get('url', 'ws://localhost:3000/ocpp')!,
    key: get('key'),
    idTag: get('idTag', 'TAG-0001')!,
    connector: Number(get('connector', '1')),
    seconds: Number(get('seconds', '3600')),
    carKey: (get('car', 'byd') || 'byd').toLowerCase(),
    vin: get('vin'),
    model: get('model'),
    battery: get('battery') ? Number(get('battery')) : undefined,
    soc: get('soc') ? Number(get('soc')) : undefined,
    power: get('power') ? Number(get('power')) : undefined,
    fleet: get('fleet') ? Number(get('fleet')) : undefined,
    auto: has('auto'),
  };
}

const args = parseArgs();

// ============================================================================
// Single Station Simulator Class
// ============================================================================

export class ChargePointSimulator {
  public cpId: string;
  public wsUrl: string;
  public authKey?: string;
  public car: CarPreset;
  public connectorId: number;
  public isConnected = false;
  public activeTxId: number | null = null;
  public currentSoc: number;
  public currentMeterWh: number = 100_000;
  public status: string = 'Unavailable';
  public stopRequested = false;

  private ws!: WebSocket;
  private pending = new Map<string, (payload: unknown) => void>();
  private heartbeatTimer?: NodeJS.Timeout;
  private meterTimer?: NodeJS.Timeout;

  constructor(cpId: string, wsUrl: string, car: CarPreset, connectorId = 1, authKey?: string) {
    this.cpId = cpId;
    this.wsUrl = wsUrl;
    this.car = car;
    this.connectorId = connectorId;
    this.authKey = authKey;
    this.currentSoc = car.initialSoc;
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.authKey) {
        headers.Authorization = 'Basic ' + Buffer.from(`${this.cpId}:${this.authKey}`).toString('base64');
      }

      const endpoint = `${this.wsUrl}/${encodeURIComponent(this.cpId)}`;
      this.ws = new WebSocket(endpoint, ['ocpp1.6'], { headers });

      this.ws.on('open', async () => {
        this.isConnected = true;
        this.log(`✓ WebSocket connected to ${endpoint}`);
        try {
          await this.boot();
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      this.ws.on('message', (raw) => {
        try {
          const frame = JSON.parse(raw.toString()) as unknown[];
          const [type, id] = frame as [number, string];
          if (type === 3) {
            this.pending.get(id)?.(frame[2]);
            this.pending.delete(id);
          } else if (type === 4) {
            this.log(`<- CALLERROR: ${JSON.stringify(frame[2])}`);
            this.pending.get(id)?.({});
            this.pending.delete(id);
          } else if (type === 2) {
            const action = frame[2] as string;
            const payload = (frame[3] ?? {}) as Record<string, unknown>;
            this.log(`<- ${action}`, JSON.stringify(payload));
            const replyPayload = this.handleIncomingCall(action, payload);
            this.reply(id, replyPayload);
          }
        } catch (err) {
          this.log(`frame parse error: ${(err as Error).message}`);
        }
      });

      this.ws.on('error', (err) => {
        this.log(`socket error: ${err.message}`);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        clearInterval(this.heartbeatTimer);
        clearInterval(this.meterTimer);
        this.log(`closed (${code}) ${reason.toString()}`);
      });
    });
  }

  public call<T = Record<string, unknown>>(action: string, payload: unknown): Promise<T> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (p: unknown) => void);
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify([2, id, action, payload]));
        this.log(`-> ${action}`, JSON.stringify(payload));
      }
    });
  }

  private reply(uniqueId: string, payload: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify([3, uniqueId, payload]));
    }
  }

  private log(msg: string, extra?: string) {
    const time = new Date().toLocaleTimeString();
    if (extra) {
      console.log(`[${time}] [${this.cpId}] ${msg}`, extra);
    } else {
      console.log(`[${time}] [${this.cpId}] ${msg}`);
    }
  }

  public async boot(): Promise<void> {
    const boot = await this.call<{ status: string; interval: number }>('BootNotification', {
      chargePointVendor: 'EPlug-Simulator',
      chargePointModel: 'FastDC-120kW',
      chargePointSerialNumber: `SN-${this.cpId}`,
      firmwareVersion: '2.4.0',
    });

    if (boot.status !== 'Accepted') {
      this.log(`Boot rejected: ${boot.status}`);
      return;
    }

    const interval = (boot.interval || 300) * 1000;
    this.heartbeatTimer = setInterval(() => void this.call('Heartbeat', {}), interval);
    this.heartbeatTimer.unref();

    // Connector 0 (charge box) and Connector 1 (gun)
    await this.call('StatusNotification', {
      connectorId: 0,
      errorCode: 'NoError',
      status: 'Available',
      timestamp: new Date().toISOString(),
    });

    await this.call('StatusNotification', {
      connectorId: this.connectorId,
      errorCode: 'NoError',
      status: 'Available',
      timestamp: new Date().toISOString(),
    });
    this.status = 'Available';

    this.log(`✓ Station online and Available. Ready for vehicle plug-in.`);
  }

  /** Step 1: Cable plugged into vehicle. Sends GB/T DataTransfer handshake with VIN & Car specs */
  public async plugInVehicle(): Promise<void> {
    this.log(`⚡ Cable plugged into ${this.car.name} (VIN: ${this.car.vin})`);

    // 1. Status -> Preparing
    await this.call('StatusNotification', {
      connectorId: this.connectorId,
      errorCode: 'NoError',
      status: 'Preparing',
      timestamp: new Date().toISOString(),
    });
    this.status = 'Preparing';

    // 2. GB/T BRM Handshake via DataTransfer
    this.log(`-> Sending GB/T DataTransfer handshake with vehicle info...`);
    await this.call('DataTransfer', {
      vendorId: 'GBT',
      messageId: 'BRM',
      data: JSON.stringify({
        vin: this.car.vin,
        carModel: this.car.name,
        batteryCapacity: this.car.batteryKwh,
        soc: this.currentSoc,
        maxPowerKw: this.car.maxPowerKw,
      }),
    });

    this.log(`✓ Vehicle handshake complete! Waiting for authorization/start.`);
  }

  /** Step 2: Start charging transaction */
  public async startTransaction(idTag = args.idTag): Promise<number | null> {
    this.log(`Authorizing idTag ${idTag}...`);
    const auth = await this.call<{ idTagInfo: { status: string } }>('Authorize', { idTag });
    this.log(`Authorize response: ${auth.idTagInfo?.status}`);

    if (auth.idTagInfo?.status !== 'Accepted') {
      this.log(`✗ Authorization refused for ${idTag}`);
      return null;
    }

    const start = await this.call<{ transactionId: number }>('StartTransaction', {
      connectorId: this.connectorId,
      idTag,
      meterStart: this.currentMeterWh,
      timestamp: new Date().toISOString(),
    });

    this.activeTxId = start.transactionId;

    await this.call('StatusNotification', {
      connectorId: this.connectorId,
      errorCode: 'NoError',
      status: 'Charging',
      timestamp: new Date().toISOString(),
    });
    this.status = 'Charging';
    this.stopRequested = false;

    this.log(`✓ Transaction #${this.activeTxId} started! Charging in progress...`);
    this.startMeterStreaming();
    return this.activeTxId;
  }

  private startMeterStreaming(): void {
    clearInterval(this.meterTimer);
    this.meterTimer = setInterval(async () => {
      if (!this.activeTxId || this.stopRequested) return;

      // Realistic charging physics: power tapers as battery approaches 80%+
      let powerKw = this.car.maxPowerKw;
      if (this.currentSoc > 80) {
        powerKw = Math.max(15, this.car.maxPowerKw * (1 - (this.currentSoc - 80) / 25));
      }

      // Energy added in 5 seconds
      const energyWh = Math.round((powerKw * 1000 * 5) / 3600);
      this.currentMeterWh += energyWh;

      // Increment battery SoC
      const addedSoc = (energyWh / (this.car.batteryKwh * 1000)) * 100;
      this.currentSoc = Math.min(100, Math.round((this.currentSoc + addedSoc) * 10) / 10);

      this.log(`⚡ Charging: ${powerKw.toFixed(1)} kW | SoC: ${this.currentSoc}% | Meter: ${(this.currentMeterWh / 1000).toFixed(2)} kWh`);

      await this.call('MeterValues', {
        connectorId: this.connectorId,
        transactionId: this.activeTxId,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: String(this.currentMeterWh),
                measurand: 'Energy.Active.Import.Register',
                unit: 'Wh',
                context: 'Sample.Periodic',
              },
              {
                value: String(Math.round(powerKw * 1000)),
                measurand: 'Power.Active.Import',
                unit: 'W',
              },
              {
                value: String(Math.round(this.currentSoc)),
                measurand: 'SoC',
                unit: 'Percent',
              },
            ],
          },
        ],
      });

      if (this.currentSoc >= 100) {
        this.log(`🔋 Battery fully charged to 100%! Auto-stopping...`);
        void this.stopTransaction('EVDeparted');
      }
    }, 5000);
    this.meterTimer.unref();
  }

  /** Step 3: Stop transaction and unplug */
  public async stopTransaction(reason = 'Local'): Promise<void> {
    if (!this.activeTxId) return;
    this.stopRequested = true;
    clearInterval(this.meterTimer);

    const txId = this.activeTxId;
    this.activeTxId = null;

    await this.call('StatusNotification', {
      connectorId: this.connectorId,
      errorCode: 'NoError',
      status: 'Finishing',
      timestamp: new Date().toISOString(),
    });
    this.status = 'Finishing';

    await this.call('StopTransaction', {
      transactionId: txId,
      idTag: args.idTag,
      meterStop: this.currentMeterWh,
      timestamp: new Date().toISOString(),
      reason,
    });

    this.log(`✓ Transaction #${txId} stopped.`);

    // Unplug -> Available
    setTimeout(async () => {
      await this.call('StatusNotification', {
        connectorId: this.connectorId,
        errorCode: 'NoError',
        status: 'Available',
        timestamp: new Date().toISOString(),
      });
      this.status = 'Available';
      this.log(`✓ Cable unplugged. Connector is Available.`);
    }, 1500);
  }

  /** Inject fault / error */
  public async injectFault(errorCode = 'GroundFailure'): Promise<void> {
    this.log(`⚠️ Injecting fault: ${errorCode}`);
    await this.call('StatusNotification', {
      connectorId: this.connectorId,
      errorCode,
      status: 'Faulted',
      info: 'Simulated hardware alert',
      timestamp: new Date().toISOString(),
    });
    this.status = 'Faulted';
  }

  public async clearFault(): Promise<void> {
    this.log(`✓ Clearing fault -> Available`);
    await this.call('StatusNotification', {
      connectorId: this.connectorId,
      errorCode: 'NoError',
      status: 'Available',
      timestamp: new Date().toISOString(),
    });
    this.status = 'Available';
  }

  private handleIncomingCall(action: string, payload: Record<string, unknown>): unknown {
    switch (action) {
      case 'RemoteStartTransaction': {
        const idTag = String(payload.idTag ?? args.idTag);
        this.log(`(RemoteStartTransaction received from Central System for ${idTag})`);
        setTimeout(async () => {
          if (this.status === 'Available') {
            await this.plugInVehicle();
          }
          await this.startTransaction(idTag);
        }, 500);
        return { status: 'Accepted' };
      }

      case 'RemoteStopTransaction': {
        this.log(`(RemoteStopTransaction received from Central System)`);
        setTimeout(() => void this.stopTransaction('Remote'), 500);
        return { status: 'Accepted' };
      }

      case 'GetConfiguration':
        return {
          configurationKey: [
            { key: 'HeartbeatInterval', readonly: false, value: '300' },
            { key: 'NumberOfConnectors', readonly: true, value: '2' },
            { key: 'SecurityProfile', readonly: false, value: '1' },
            { key: 'MeterValueSampleInterval', readonly: false, value: '5' },
          ],
          unknownKey: [],
        };

      case 'ChangeConfiguration':
        return { status: 'Accepted' };

      case 'UnlockConnector':
        this.log(`(UnlockConnector received)`);
        return { status: 'Unlocked' };

      case 'DataTransfer':
        this.log(`(DataTransfer received: ${JSON.stringify(payload)})`);
        return { status: 'Accepted' };

      case 'Reset':
        this.log(`(Reset requested: ${payload.type})`);
        setTimeout(() => void this.boot(), 1000);
        return { status: 'Accepted' };

      default:
        return { status: 'Accepted' };
    }
  }
}

// ============================================================================
// Main Entrypoint (Interactive or Fleet Mode)
// ============================================================================

async function main() {
  const preset = CAR_PRESETS[args.carKey] || CAR_PRESETS.byd;
  const car: CarPreset = {
    name: args.model || preset.name,
    vin: args.vin || preset.vin,
    batteryKwh: args.battery || preset.batteryKwh,
    maxPowerKw: args.power || preset.maxPowerKw,
    initialSoc: args.soc !== undefined ? args.soc : preset.initialSoc,
  };

  // Fleet / Load Test Mode
  if (args.fleet && args.fleet > 1) {
    console.log(`\n======================================================`);
    console.log(`  FLEET LOAD TEST: Spawning ${args.fleet} Virtual Stations`);
    console.log(`  Target CSMS URL: ${args.url}`);
    console.log(`======================================================\n`);

    const simulators: ChargePointSimulator[] = [];
    for (let i = 1; i <= args.fleet; i++) {
      const padId = `CP-LOAD-${String(i).padStart(3, '0')}`;
      const sim = new ChargePointSimulator(padId, args.url, car, 1);
      simulators.push(sim);
    }

    console.log(`Connecting all ${args.fleet} stations...`);
    let connected = 0;
    for (const sim of simulators) {
      sim.connect().then(() => {
        connected++;
        if (connected === simulators.length) {
          console.log(`\n✓ All ${connected} virtual stations connected and ready!`);
        }
      }).catch((e) => console.error(`Error connecting ${sim.cpId}:`, e.message));
      await new Promise((r) => setTimeout(r, 100)); // slight stagger
    }
    return;
  }

  // Single Station Interactive Mode
  console.log(`\n======================================================`);
  console.log(`  E-PLUG OCPP 1.6J CHARGER SIMULATOR`);
  console.log(`======================================================`);
  console.log(`  Station ID  : ${args.id}`);
  console.log(`  Target URL  : ${args.url}`);
  console.log(`  Vehicle     : ${car.name}`);
  console.log(`  Vehicle VIN : ${car.vin}`);
  console.log(`  Battery     : ${car.batteryKwh} kWh (${car.initialSoc}% initial SoC)`);
  console.log(`  Max Power   : ${car.maxPowerKw} kW DC Fast Charge`);
  console.log(`======================================================\n`);

  const sim = new ChargePointSimulator(args.id, args.url, car, args.connector, args.key);
  await sim.connect();

  if (args.auto) {
    console.log(`--auto specified: running full automated charging cycle...`);
    await sim.plugInVehicle();
    await sim.startTransaction();
    return;
  }

  console.log(`\n[Interactive Keyboard Controls]:`);
  console.log(`  [p] - Plug in car (sends DataTransfer with VIN: ${car.vin})`);
  console.log(`  [s] - Swipe RFID / Start Charging session`);
  console.log(`  [x] - Stop transaction & Unplug`);
  console.log(`  [f] - Inject hardware fault (GroundFailure)`);
  console.log(`  [c] - Clear fault`);
  console.log(`  [q] - Quit\n`);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on('keypress', async (_str, key) => {
    if (key.ctrl && key.name === 'c') process.exit(0);
    switch (key.name) {
      case 'p':
        await sim.plugInVehicle();
        break;
      case 's':
        await sim.startTransaction();
        break;
      case 'x':
        await sim.stopTransaction('Local');
        break;
      case 'f':
        await sim.injectFault('GroundFailure');
        break;
      case 'c':
        await sim.clearFault();
        break;
      case 'q':
        process.exit(0);
        break;
    }
  });
}

void main();
