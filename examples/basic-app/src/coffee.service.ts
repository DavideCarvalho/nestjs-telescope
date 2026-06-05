// The "business logic" of the demo. Each method exercises a different slice of
// Telescope so the dashboard fills with realistic, varied data:
//  - record()'d queries shaped exactly like an ORM logger ({ sql, bindings, took })
//  - a CacheWatcher fed by a custom emitter (a per-request hit/miss)
//  - telescopeDump() of the order, correlated to the active request
//  - varied latencies + an occasional thrown exception (1 in 10)

import {
  EntryType,
  type RecordInput,
  TelescopeService,
  queryFamilyHash,
  telescopeDump,
} from '@dudousxd/nestjs-telescope';
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { CACHE_EMIT_HOLDER, CacheEmitHolder } from './cache-emit-holder.js';

export interface CoffeeMenuItem {
  name: string;
  priceCents: number;
}

export interface CoffeeOrder {
  id: number;
  drink: string;
  shots: number;
  priceCents: number;
}

const DEFAULT_ITEM: CoffeeMenuItem = { name: 'flat white', priceCents: 400 };

const MENU: readonly CoffeeMenuItem[] = [
  { name: 'espresso', priceCents: 250 },
  DEFAULT_ITEM,
  { name: 'cortado', priceCents: 350 },
  { name: 'cold brew', priceCents: 450 },
];

@Injectable()
export class CoffeeService {
  private orderCounter = 0;

  constructor(
    @Inject(TelescopeService) private readonly telescope: TelescopeService,
    @Inject(CACHE_EMIT_HOLDER) private readonly cache: CacheEmitHolder,
  ) {}

  /** Reading the menu: one cached lookup + one indexed query. */
  async readMenu(): Promise<readonly CoffeeMenuItem[]> {
    const hit = this.orderCounter % 4 !== 0;
    this.cache.fireLookup('menu:v1', hit);
    if (!hit) {
      await this.recordQuery('select name, price_cents from menu_item order by name', [], 6);
      await this.sleep(8);
    }
    return MENU;
  }

  /** Placing an order: a couple of queries, a cache lookup, a dump, latency, and
   *  an occasional brew failure. */
  async placeOrder(drink: string, shots: number): Promise<CoffeeOrder> {
    const orderIndex = this.orderCounter++;
    const item = MENU.find((entry) => entry.name === drink) ?? DEFAULT_ITEM;

    // Look up a regular's loyalty record — usually a cache hit, sometimes a miss.
    const loyaltyHit = orderIndex % 3 !== 0;
    this.cache.fireLookup(`loyalty:customer:${orderIndex % 16}`, loyaltyHit);
    if (!loyaltyHit) {
      await this.recordQuery(
        'select points from loyalty where customer_id = ? limit 1',
        [orderIndex % 16],
        4,
      );
    }

    const priceCents = item.priceCents + Math.max(0, shots - 1) * 75;
    const order: CoffeeOrder = { id: orderIndex, drink: item.name, shots, priceCents };

    // Persist the order — an insert the dashboard surfaces in the Queries tab.
    await this.recordQuery(
      'insert into coffee_order (drink, shots, price_cents) values (?, ?, ?)',
      [order.drink, order.shots, order.priceCents],
      9 + (orderIndex % 7),
    );

    // A correlated debug dump — shows up in the Dumps tab tied to this request.
    telescopeDump(order, 'coffee.order');

    // Varied brew time so the latency histogram isn't a flat line.
    await this.sleep(15 + (orderIndex % 5) * 12);

    // The barista drops a cup once in a while (1 in 10) — exercises the
    // exception watcher and the dashboard's error rate card.
    if (orderIndex % 10 === 0) {
      throw new InternalServerErrorException('barista dropped the cup ☕💥');
    }

    return order;
  }

  /** Record a query entry shaped like an ORM logger emits it. */
  private async recordQuery(sql: string, bindings: unknown[], took: number): Promise<void> {
    const input: RecordInput = {
      type: EntryType.Query,
      content: { sql, bindings, took },
      familyHash: queryFamilyHash(sql),
      durationMs: took,
    };
    this.telescope.record(input);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
