// integration/memory-soak/src/load-driver.ts
//
// Drives sustained HTTP load against the listening Nest server over a keep-alive
// agent (one persistent connection pool, like an ALB in front of the pods), so
// the real ALS / middleware / `finish` capture paths are exercised by genuine
// sockets — not synthetic in-process calls. Keeps `concurrency` requests in
// flight at all times until stopped.

import http from 'node:http';

export interface LoadDriver {
  stop(): Promise<void>;
  completed(): number;
}

/** Start `concurrency` self-replenishing request loops against `baseUrl/work`. */
export function startLoad(baseUrl: string, concurrency: number): LoadDriver {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const target = new URL('/work', baseUrl);
  let running = true;
  let completedCount = 0;
  const loops: Promise<void>[] = [];

  function once(): Promise<void> {
    return new Promise<void>((resolve) => {
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'GET',
          agent,
        },
        (res) => {
          // Drain so the socket frees for keep-alive reuse.
          res.on('data', () => {});
          res.on('end', () => {
            completedCount += 1;
            resolve();
          });
          res.on('error', () => resolve());
        },
      );
      req.on('error', () => resolve());
      req.end();
    });
  }

  async function loop(): Promise<void> {
    while (running) {
      await once();
    }
  }

  for (let index = 0; index < concurrency; index += 1) {
    loops.push(loop());
  }

  return {
    completed: () => completedCount,
    stop: async () => {
      running = false;
      await Promise.all(loops);
      agent.destroy();
    },
  };
}
