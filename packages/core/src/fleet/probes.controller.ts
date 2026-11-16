// packages/core/src/fleet/probes.controller.ts
//
// `GET <path>/api/probes/ready` and `/live`: unauthenticated, for a load balancer or a kubelet.
// Mounted on every app and a 404 unless `health: { probes: true }`. Not behind `authorize` or
// `decorators`; bodies carry names and statuses only.
import { Controller, Get, HttpException, Inject, NotFoundException } from '@nestjs/common';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from '../nest/telescope.options.js';
import { TelescopeFleet } from './fleet.service.js';

export interface ProbeAnswer {
  status: 'ok' | 'warn' | 'down';
  state?: string;
  checks?: { name: string; status: string }[];
}

@Controller('telescope/api/probes')
export class TelescopeProbesController {
  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TelescopeFleet) private readonly fleet: TelescopeFleet,
  ) {}

  private requireProbes(): void {
    if (this.options.health?.probes !== true) throw new NotFoundException();
  }

  /** 200 when ready; 503 while a critical check is down or the instance drains. */
  @Get('ready')
  async ready(): Promise<ProbeAnswer> {
    this.requireProbes();
    const report = await this.fleet.readiness();
    const body: ProbeAnswer = {
      status: report.status,
      state: report.state,
      checks: report.checks.map((check) => ({ name: check.name, status: check.status })),
    };
    if (!report.ready) throw new HttpException(body, 503);
    return body;
  }

  /** 200 while the process answers; never runs the checks. */
  @Get('live')
  live(): ProbeAnswer {
    this.requireProbes();
    return { status: 'ok' };
  }
}
