import { z } from 'zod';

/** OCPP dateTime: ISO-8601. Accepts a string, yields a Date. */
export const DateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/))
  .transform((v) => new Date(v))
  .refine((d) => !Number.isNaN(d.getTime()), { message: 'Invalid dateTime' });

export const CiString = (max: number) => z.string().max(max);
export const IdToken = z.string().max(20);
export const ConnectorId = z.number().int().nonnegative();
export const PositiveConnectorId = z.number().int().positive();

export const AuthorizationStatusSchema = z.enum([
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
]);

export const IdTagInfoSchema = z.object({
  expiryDate: DateTimeSchema.optional(),
  parentIdTag: IdToken.optional(),
  status: AuthorizationStatusSchema,
});
export type IdTagInfo = z.infer<typeof IdTagInfoSchema>;

export const ChargePointStatusSchema = z.enum([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
]);

export const ChargePointErrorCodeSchema = z.enum([
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'NoError',
  'OtherError',
  'OverCurrentFailure',
  'OverVoltage',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'UnderVoltage',
  'WeakSignal',
]);

export const ReadingContextSchema = z.enum([
  'Interruption.Begin',
  'Interruption.End',
  'Other',
  'Sample.Clock',
  'Sample.Periodic',
  'Transaction.Begin',
  'Transaction.End',
  'Trigger',
]);

export const MeasurandSchema = z.enum([
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'Power.Factor',
  'Current.Import',
  'Current.Export',
  'Current.Offered',
  'Voltage',
  'Frequency',
  'Temperature',
  'SoC',
  'RPM',
]);

export const PhaseSchema = z.enum([
  'L1',
  'L2',
  'L3',
  'N',
  'L1-N',
  'L2-N',
  'L3-N',
  'L1-L2',
  'L2-L3',
  'L3-L1',
]);

export const UnitOfMeasureSchema = z.enum([
  'Wh',
  'kWh',
  'varh',
  'kvarh',
  'W',
  'kW',
  'VA',
  'kVA',
  'var',
  'kvar',
  'A',
  'V',
  'K',
  'Celcius',
  'Celsius',
  'Fahrenheit',
  'Percent',
]);

export const SampledValueSchema = z.object({
  value: z.string(),
  context: ReadingContextSchema.optional(),
  format: z.enum(['Raw', 'SignedData']).optional(),
  measurand: MeasurandSchema.optional(),
  phase: PhaseSchema.optional(),
  location: z.enum(['Cable', 'EV', 'Inlet', 'Outlet', 'Body']).optional(),
  unit: UnitOfMeasureSchema.optional(),
});
export type SampledValue = z.infer<typeof SampledValueSchema>;

export const MeterValueSchema = z.object({
  timestamp: DateTimeSchema,
  sampledValue: z.array(SampledValueSchema).min(1),
});
export type MeterValueEntry = z.infer<typeof MeterValueSchema>;

export const ChargingRateUnitSchema = z.enum(['A', 'W']);

export const ChargingSchedulePeriodSchema = z.object({
  startPeriod: z.number().int(),
  limit: z.number(),
  numberPhases: z.number().int().optional(),
});

export const ChargingScheduleSchema = z.object({
  duration: z.number().int().optional(),
  startSchedule: DateTimeSchema.optional(),
  chargingRateUnit: ChargingRateUnitSchema,
  chargingSchedulePeriod: z.array(ChargingSchedulePeriodSchema).min(1),
  minChargingRate: z.number().optional(),
});

export const ChargingProfileSchema = z.object({
  chargingProfileId: z.number().int(),
  transactionId: z.number().int().optional(),
  stackLevel: z.number().int().nonnegative(),
  chargingProfilePurpose: z.enum(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile']),
  chargingProfileKind: z.enum(['Absolute', 'Recurring', 'Relative']),
  recurrencyKind: z.enum(['Daily', 'Weekly']).optional(),
  validFrom: DateTimeSchema.optional(),
  validTo: DateTimeSchema.optional(),
  chargingSchedule: ChargingScheduleSchema,
});

export const EmptySchema = z.object({}).passthrough();
