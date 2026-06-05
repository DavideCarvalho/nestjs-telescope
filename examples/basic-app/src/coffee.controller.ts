// The demo's REST surface. A handful of fun endpoints the traffic seeder (and
// you, via curl or the browser) hit to fill the Telescope dashboard.

import { Body, Controller, Get, Post } from '@nestjs/common';
import { type CoffeeMenuItem, type CoffeeOrder, CoffeeService } from './coffee.service.js';

interface OrderBody {
  drink?: string;
  shots?: number;
}

@Controller('coffee')
export class CoffeeController {
  constructor(private readonly coffee: CoffeeService) {}

  @Get('menu')
  async menu(): Promise<readonly CoffeeMenuItem[]> {
    return this.coffee.readMenu();
  }

  @Post('order')
  async order(@Body() body: OrderBody): Promise<CoffeeOrder> {
    const drink = typeof body.drink === 'string' ? body.drink : 'flat white';
    const shots = typeof body.shots === 'number' ? body.shots : 1;
    return this.coffee.placeOrder(drink, shots);
  }
}
