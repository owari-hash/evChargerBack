import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from './logger';

mongoose.set('strictQuery', true);

export async function connectDatabase(): Promise<typeof mongoose> {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });

  // Build indexes declared on the models. Safe to run on every boot.
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));

  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
}
