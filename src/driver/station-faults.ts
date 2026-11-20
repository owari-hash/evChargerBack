/**
 * Turns the error a station reported during a session (OCPP errorCode plus the
 * vendor's own code, e.g. HICI "BMSBatteryTemperatureFault") into a short,
 * plain-language explanation for the driver, in Mongolian and English.
 *
 * The wording lives here, not in the app, so a new vendor code only needs a
 * backend deploy. Matching is by keywords in the vendor code, so codes from
 * other vendors that use similar names are covered too.
 */

export type StationFaultKind =
  | 'battery_temperature'
  | 'battery_voltage'
  | 'battery_current'
  | 'battery_bms'
  | 'vehicle_communication'
  | 'plug'
  | 'insulation'
  | 'emergency_stop'
  | 'station_overheat'
  | 'power_supply'
  | 'station_fault';

export interface StationFault {
  kind: StationFaultKind;
  /** The station's own code, for support ("BMSBatteryTemperatureFault"). */
  code: string;
  /** Whether the problem is on the car's side (true) or the station's (false). */
  vehicleSide: boolean;
  mn: { title: string; body: string };
  en: { title: string; body: string };
}

type Text = Omit<StationFault, 'code'>;

const TEXT: Record<StationFaultKind, Text> = {
  battery_temperature: {
    kind: 'battery_temperature',
    vehicleSide: true,
    mn: {
      title: 'Машины батерейн хэм хэвийн бус байна',
      body: 'Цэнэглэлт амжилтгүй боллоо. Батерей хэт халсан эсвэл хэт хүйтэн байна. Машиныг хэсэг хугацаанд амрааж (хүйтэнд бол халааж) байгаад дахин оролдоно уу.',
    },
    en: {
      title: "Car battery temperature is out of range",
      body: 'Charging failed. The battery is too hot or too cold. Let the car rest (or warm it up in cold weather) for a while and try again.',
    },
  },
  battery_voltage: {
    kind: 'battery_voltage',
    vehicleSide: true,
    mn: {
      title: 'Машины батерейн хүчдэл хэвийн бус байна',
      body: 'Цэнэглэлт амжилтгүй боллоо. Машин батерейн хүчдэлийн алдаа мэдээлсэн. Машинаа унтрааж асаагаад дахин оролдоно уу. Давтагдвал машины засварт хандана уу.',
    },
    en: {
      title: 'Car battery voltage is out of range',
      body: 'Charging failed. The car reported a battery voltage fault. Turn the car off and on and try again. If it repeats, have the car checked.',
    },
  },
  battery_current: {
    kind: 'battery_current',
    vehicleSide: true,
    mn: {
      title: 'Машины цэнэглэх гүйдэл хэвийн бус байна',
      body: 'Цэнэглэлт амжилтгүй боллоо. Машин цэнэглэх гүйдлийн алдаа мэдээлсэн. Бууг салгаад дахин залгаж оролдоно уу.',
    },
    en: {
      title: 'Charging current fault from the car',
      body: 'Charging failed. The car reported a charging current fault. Unplug the gun, plug it in again and retry.',
    },
  },
  battery_bms: {
    kind: 'battery_bms',
    vehicleSide: true,
    mn: {
      title: 'Машины батерей цэнэглэлтийг зогсоолоо',
      body: 'Цэнэглэлт амжилтгүй боллоо. Машины батерейн удирдлагын систем (BMS) алдаа мэдээлсэн. Машинаа унтрааж асаагаад, бууг дахин залгаж оролдоно уу.',
    },
    en: {
      title: "The car's battery stopped charging",
      body: "Charging failed. The car's battery management system (BMS) reported a fault. Turn the car off and on, plug the gun in again and retry.",
    },
  },
  vehicle_communication: {
    kind: 'vehicle_communication',
    vehicleSide: true,
    mn: {
      title: 'Машинтай холбогдож чадсангүй',
      body: 'Цэнэглэлт амжилтгүй боллоо. Станц таны машинтай мэдээлэл солилцож чадсангүй. Бууг салгаад, бүрэн дахин залгаад цэнэглэнэ үү.',
    },
    en: {
      title: 'Could not communicate with the car',
      body: 'Charging failed. The station could not talk to your car. Unplug the gun, plug it in fully again and start charging.',
    },
  },
  plug: {
    kind: 'plug',
    vehicleSide: true,
    mn: {
      title: 'Цэнэглэлт эхэлсэнгүй',
      body: 'Станц таны машинтай холболтыг баталгаажуулж чадсангүй. Цэнэглэх буугаа салгаад, дахин бүрэн залгаад цэнэглэнэ үү.',
    },
    en: {
      title: 'Charging did not start',
      body: 'The station could not confirm the connection with your car. Unplug the gun, plug it in fully again and start charging.',
    },
  },
  insulation: {
    kind: 'insulation',
    vehicleSide: false,
    mn: {
      title: 'Аюулгүй байдлын шалгалт амжилтгүй',
      body: 'Цэнэглэлт амжилтгүй боллоо. Цэнэглэхийн өмнөх тусгаарлагчийн шалгалт давсангүй. Бууг салгаад дахин залгаж оролдоно уу. Давтагдвал өөр буу ашиглана уу.',
    },
    en: {
      title: 'Safety check failed',
      body: 'Charging failed. The insulation check before charging did not pass. Unplug the gun, plug it in again and retry. If it repeats, use another gun.',
    },
  },
  emergency_stop: {
    kind: 'emergency_stop',
    vehicleSide: false,
    mn: {
      title: 'Яаралтай зогсоох товч дарагдсан',
      body: 'Станцын яаралтай зогсоох товч дарагдсан тул цэнэглэлт зогслоо. Товчийг суллаж (эргүүлж) байгаад дахин оролдоно уу.',
    },
    en: {
      title: 'Emergency stop pressed',
      body: "Charging stopped because the station's emergency stop button was pressed. Release it (twist to unlock) and try again.",
    },
  },
  station_overheat: {
    kind: 'station_overheat',
    vehicleSide: false,
    mn: {
      title: 'Станц хэт халсан',
      body: 'Цэнэглэлт амжилтгүй боллоо. Станцын хэм хэт өндөр байна. Хэдэн минут хүлээгээд дахин оролдоно уу эсвэл өөр станц ашиглана уу.',
    },
    en: {
      title: 'Station overheated',
      body: 'Charging failed. The station is too hot. Wait a few minutes and try again, or use another station.',
    },
  },
  power_supply: {
    kind: 'power_supply',
    vehicleSide: false,
    mn: {
      title: 'Цахилгаан тэжээлийн асуудал гарлаа',
      body: 'Цэнэглэлт амжилтгүй боллоо. Станцын цахилгаан тэжээлд түр асуудал гарсан. Хэсэг хүлээгээд дахин оролдоно уу.',
    },
    en: {
      title: 'Power supply problem',
      body: "Charging failed. There was a temporary problem with the station's power supply. Wait a little and try again.",
    },
  },
  station_fault: {
    kind: 'station_fault',
    vehicleSide: false,
    mn: {
      title: 'Станцын алдаагаар цэнэглэлт зогслоо',
      body: 'Цэнэглэлт амжилтгүй боллоо. Хэсэг хүлээгээд дахин оролдоно уу эсвэл өөр буу ашиглана уу. Асуудал давтагдвал бидэнтэй холбогдоно уу.',
    },
    en: {
      title: 'Charging stopped by a station fault',
      body: 'Charging failed. Wait a little and try again, or use another gun. If it keeps happening, contact us.',
    },
  },
};

/** Vendor-code keyword rules, checked in order (most specific first). */
const VENDOR_RULES: [RegExp, StationFaultKind][] = [
  [/emergency|e-?stop|scram/i, 'emergency_stop'],
  [/cc[12]|plug|gun.*(detect|insert|connect|lock)|connector.*(detect|lock)/i, 'plug'],
  [/insulat|imd\b|leakage/i, 'insulation'],
  [/(bms|battery|vehicle|ev).*(temp|thermal|heat)|(temp|thermal).*(bms|battery)/i, 'battery_temperature'],
  [/(bms|battery|vehicle|ev).*(volt)|(volt).*(bms|battery)/i, 'battery_voltage'],
  [/(bms|battery|vehicle|ev).*(current)/i, 'battery_current'],
  [/(bms|ev|vehicle|car).*(comm|timeout|handshake|message)|\b(brm|bcp|bro|bcl|bcs|bst|bem|chm)\b/i, 'vehicle_communication'],
  [/bms|battery/i, 'battery_bms'],
  [/(over|high).*temp|temp.*(over|high)|thermal|overheat|fan/i, 'station_overheat'],
  [/grid|input.*(volt|phase)|ac.*(volt|phase)|phase|mains|power.*(loss|fail|switch)|ground|earth|breaker|contactor/i, 'power_supply'],
];

/** OCPP 1.6 errorCode fallbacks when the vendor code says nothing useful. */
const OCPP_RULES: Partial<Record<string, StationFaultKind>> = {
  EVCommunicationError: 'vehicle_communication',
  ConnectorLockFailure: 'plug',
  GroundFailure: 'power_supply',
  HighTemperature: 'station_overheat',
  OverCurrentFailure: 'power_supply',
  OverVoltage: 'power_supply',
  UnderVoltage: 'power_supply',
  PowerSwitchFailure: 'power_supply',
};

export function describeStationFault(errorCode?: string | null, vendorErrorCode?: string | null): StationFault | null {
  const ocpp = (errorCode ?? '').trim();
  const vendor = (vendorErrorCode ?? '').trim();
  if ((!ocpp || ocpp === 'NoError') && !vendor) return null;

  let kind: StationFaultKind | undefined;
  if (vendor && !/^(notdefined|none|noerror|0)$/i.test(vendor)) {
    kind = VENDOR_RULES.find(([re]) => re.test(vendor))?.[1];
  }
  kind ??= OCPP_RULES[ocpp] ?? 'station_fault';

  return { ...TEXT[kind], code: vendor || ocpp };
}

/**
 * Only an error that ended the session is worth telling the driver about:
 * one reported within a few minutes of the stop, or any error on a session
 * that delivered almost nothing (it never really started).
 */
const RELEVANT_BEFORE_STOP_MS = 3 * 60_000;

export function sessionFault(tx: {
  status: string;
  stopTimestamp?: Date | null;
  energyWh?: number | null;
  stopReason?: string | null;
  stationError?: { errorCode?: string | null; vendorErrorCode?: string | null; at?: Date | null } | null;
}): StationFault | null {
  if (tx.status === 'Active' || !tx.stationError) return null;
  const fault = describeStationFault(tx.stationError.errorCode, tx.stationError.vendorErrorCode);
  if (!fault) return null;

  // Stations report a fault-stop with differing reasons (Local, Other,
  // EmergencyStop…), so timing is the test, not the reason.
  const barelyCharged = (tx.energyWh ?? 0) < 100;
  const at = tx.stationError.at ? new Date(tx.stationError.at).getTime() : undefined;
  const stop = tx.stopTimestamp ? new Date(tx.stopTimestamp).getTime() : undefined;
  const nearStop = at !== undefined && stop !== undefined && stop - at <= RELEVANT_BEFORE_STOP_MS;

  return barelyCharged || nearStop ? fault : null;
}
