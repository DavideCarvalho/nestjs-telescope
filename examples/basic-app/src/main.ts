// Boot the demo: create the Nest app, register Telescope's request capture
// globally, listen, then kick off the self-driving traffic seeder.

import 'reflect-metadata';
import { TelescopeService, telescopeRequestCapture } from '@dudousxd/nestjs-telescope';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { TrafficSeederService } from './traffic-seeder.service.js';

const DEFAULT_PORT = 3000;

function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  // Capture every request into Telescope. Registering globally (rather than as
  // module middleware) is the recommended pattern and keeps the catch-all route
  // working even if you later add a global prefix.
  app.use(telescopeRequestCapture(app.get(TelescopeService)));

  const port = resolvePort();
  await app.listen(port);

  // Start firing self-traffic so the dashboard fills on its own.
  app.get(TrafficSeederService).start(port);
}

void bootstrap();
