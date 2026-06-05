// The "fills itself" magic. On boot, this fires ~3-5 requests/second against the
// app's own endpoints (with occasional bad input that 500s) so the dashboard has
// data WITHOUT the user lifting a finger. It also prints the friendly banner
// that points at the dashboard.

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

const DRINKS: readonly string[] = ['espresso', 'flat white', 'cortado', 'cold brew'];

@Injectable()
export class TrafficSeederService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('TrafficSeeder');
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseUrl = '';
  private tick = 0;

  /** Called by bootstrap once the HTTP server has an address. */
  start(port: number): void {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.printBanner(port);
    // ~4 req/s. setInterval is intentionally simple — this is a demo seeder.
    this.timer = setInterval(() => {
      void this.fireOnce();
    }, 250);
  }

  onApplicationBootstrap(): void {
    // Nothing here — `start()` is driven from bootstrap once the port is known.
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async fireOnce(): Promise<void> {
    const step = this.tick++;
    try {
      if (step % 3 === 0) {
        await fetch(`${this.baseUrl}/coffee/menu`);
        return;
      }
      // Every 11th order sends a deliberately bad shot count so a few requests
      // 500 — the dashboard's error rate card needs something to chart.
      const drink = DRINKS[step % DRINKS.length] ?? 'flat white';
      const shots = step % 11 === 0 ? Number.NaN : 1 + (step % 3);
      await fetch(`${this.baseUrl}/coffee/order`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drink, shots }),
      });
    } catch {
      // The seeder is best-effort; a dropped request just means one fewer entry.
    }
  }

  private printBanner(port: number): void {
    const url = `http://localhost:${port}/telescope`;
    this.logger.log('');
    this.logger.log('  ☕  nestjs-telescope basic-app is brewing traffic...');
    this.logger.log(`  📊  Open the dashboard:  ${url}`);
    this.logger.log('  ⏳  Give it ~30 seconds and the dashboard will be full.');
    this.logger.log('');
  }
}
