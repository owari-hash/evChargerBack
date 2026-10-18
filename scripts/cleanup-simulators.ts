import mongoose, { Types } from 'mongoose';
import { env } from '../src/config/env';
import { ChargePoint } from '../src/models/ChargePoint';
import { Connector } from '../src/models/Connector';
import { ConfigurationKey } from '../src/models/ConfigurationKey';
import { OcppMessageLog, CommandLog } from '../src/models/Log';

async function main() {
  console.log('Connecting to MongoDB at:', env.MONGODB_URI);
  await mongoose.connect(env.MONGODB_URI);

  // Protected stations: Baganuur
  const protectedFilter = {
    $or: [
      { cpId: { $regex: /^baganuur$/i } },
      { name: { $regex: /багануур/i } },
      { _id: new Types.ObjectId('6acdecc7c2751d56f29271ae') },
    ],
  };

  const protectedStations = await ChargePoint.find(protectedFilter).select('_id cpId name').lean();
  console.log(`Protected real stations (${protectedStations.length}):`);
  for (const s of protectedStations) {
    console.log(`  - [KEEP] ${s.name || s.cpId} (id: ${s._id}, cpId: ${s.cpId})`);
  }
  const protectedIds = protectedStations.map((s) => s._id);

  // Mock stations
  const mockFilter = {
    _id: { $nin: protectedIds },
    $or: [
      { cpId: { $regex: /^(FLEET-SIM|CP-SIM|SIM-|Rey-)/i } },
      { chargePointVendor: { $regex: /^(EPlug-Fleet|EPlug-SimWeb|SimVendor|Learn EV)/i } },
    ],
  };

  const toDelete = await ChargePoint.find(mockFilter).select('_id cpId name chargePointVendor').lean();
  console.log(`\nFound ${toDelete.length} mock simulator stations to delete:`);
  for (const s of toDelete) {
    console.log(`  - [DELETE] ${s.cpId} (${s.name || 'no name'}, vendor: ${s.chargePointVendor})`);
  }

  if (toDelete.length === 0) {
    console.log('\nNo mock stations found to clean up.');
    await mongoose.disconnect();
    return;
  }

  const deleteIds = toDelete.map((s) => s._id);

  console.log('\nDeleting mock stations and related data...');
  await Promise.all([
    ChargePoint.deleteMany({ _id: { $in: deleteIds } }),
    Connector.deleteMany({ chargePointId: { $in: deleteIds } }),
    ConfigurationKey.deleteMany({ chargePointId: { $in: deleteIds } }),
    OcppMessageLog.deleteMany({ chargePointId: { $in: deleteIds } }),
    CommandLog.deleteMany({ chargePointId: { $in: deleteIds } }),
  ]);

  console.log(`Successfully deleted ${deleteIds.length} mock stations!`);
  console.log('Real station(s) preserved intact.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Cleanup error:', err);
  process.exit(1);
});
