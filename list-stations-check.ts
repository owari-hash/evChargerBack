import mongoose from 'mongoose';
import { ChargePoint } from './src/models/ChargePoint';
import { env } from './src/config/env';

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const stations = await ChargePoint.find({}).sort({ createdAt: 1 }).lean();
  console.log(`TOTAL STATIONS: ${stations.length}`);
  for (const s of stations) {
    console.log(JSON.stringify({
      id: String(s._id),
      cpId: s.cpId,
      name: s.name,
      vendor: s.chargePointVendor,
      model: s.chargePointModel,
      createdAt: s.createdAt,
    }));
  }
  await mongoose.disconnect();
}

main().catch(console.error);
