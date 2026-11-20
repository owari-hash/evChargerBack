import { describeStationFault, sessionFault } from '../src/driver/station-faults';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const kind = (vendor: string, ocpp = 'OtherError') => describeStationFault(ocpp, vendor)?.kind;

assert(kind('BMSBatteryTemperatureFault') === 'battery_temperature', 'BMS battery temperature');
assert(kind('BatteryOverVoltage') === 'battery_voltage', 'battery voltage');
assert(kind('BMSOtherFaults') === 'battery_bms', 'other BMS fault');
assert(kind('InsulationCommunicationFault') === 'insulation', 'insulation (not vehicle comms)');
assert(kind('CC1Abnormal') === 'plug', 'CC1 plug detect');
assert(kind('EmergencyStopFault') === 'emergency_stop', 'emergency stop');
assert(kind('BMSCommunicationTimeout') === 'vehicle_communication', 'BMS comms timeout');
assert(kind('ModuleOverTemperature') === 'station_overheat', 'station overheat');
assert(kind('NotDefined') === 'station_fault', 'NotDefined falls back to generic');
assert(kind('', 'EVCommunicationError') === 'vehicle_communication', 'OCPP errorCode fallback');
assert(describeStationFault('NoError', '') === null, 'NoError → nothing');
assert(describeStationFault('OtherError', 'BMSBatteryTemperatureFault')!.mn.title === 'Машины батерейн хэм хэвийн бус байна', 'Mongolian title');

const stop = new Date('2026-11-19T05:12:30Z');
const err = { errorCode: 'OtherError', vendorErrorCode: 'BMSBatteryTemperatureFault', at: new Date('2026-11-19T05:11:37Z') };
assert(sessionFault({ status: 'Completed', stopTimestamp: stop, energyWh: 8000, stopReason: 'Other', stationError: err })?.kind === 'battery_temperature', 'error right before stop is shown');
assert(sessionFault({ status: 'Active', energyWh: 0, stationError: err }) === null, 'not while still charging');
assert(
  sessionFault({ status: 'Completed', stopTimestamp: new Date('2026-11-19T06:30:00Z'), energyWh: 30000, stopReason: 'Local', stationError: err }) === null,
  'old hiccup on a normal long session is not shown',
);
assert(
  sessionFault({ status: 'Completed', stopTimestamp: new Date('2026-11-19T06:30:00Z'), energyWh: 20, stopReason: 'Local', stationError: err })?.kind === 'battery_temperature',
  'barely-charged session shows the error',
);
console.log('\nAll station fault tests passed.');
