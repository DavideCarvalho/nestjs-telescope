---
'@dudousxd/nestjs-telescope': major
---

**Breaking: every HTTP list endpoint moves to the Aviary list API, and telescope's own MCP endpoint is removed.**

### List endpoints

One wire for every list: filters as `filter[field]=value`, cursor lists paged with `after` / `first` and answered as `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`, offset lists with `page` / `size` answered as `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }`. The old parameters are not aliased: `limit`, `cursor`, `offset`, `prefix`, `dir`, a bare `?type=` / `?state=` and `filter.<col>` answer **400** with the parameter to use instead, as do an unknown filter field, an unsupported operator, a sort field outside the allow-list and a malformed cursor.

| Endpoint | Before | After |
|---|---|---|
| `GET entries` | `?type=&tag=&familyHash=&batchId=&traceId=&search=&cursor=&limit=` (uncapped) → `{ data, nextCursor, partial? }` | `?filter[type]=&filter[tag]=&filter[familyHash]=&filter[batchId]=&filter[traceId]=&search=&after=&first=` (default 50, max 500) → `{ data, meta, partial? }`. Forward only: `before` / `last` are a 400. |
| `GET tags` | `?prefix=&search=&limit=&offset=` → `TagCount[]` | `?filter[tag][startsWith]=&search=&after=&first=` (default 50, max 200) → `{ data, meta }`. A cursor list, not an offset one: the store pages tags in a stable order but cannot count them. |
| `GET queues/live/:driver/:queue/jobs` | `?state=&cursor=&limit=` → `{ jobs, nextCursor, total: null }` | `?filter[state]=&after=&first=` (default 50, max 200) → `{ data, meta }`. The `QueueManager.listJobs({ cursor, limit })` SPI and its `JobPage` are unchanged; the route translates. |
| `GET traces` | `?window=&limit=` → `{ traces, scanned, truncated }` | `?window=&size=` (default 50, max 500) → `{ data, scanned, truncated }` |
| `GET profiles` | `?limit=` → `{ data, nextCursor }` (with no way to send the cursor back) | `?after=&first=` (default 50, max 200) → `{ data, meta }`: a real cursor list. |
| `GET ext/:ext/data/:provider` (paged table) | `?page=&limit=&sort=col&dir=desc&filter.col=` → `{ rows, total, page, limit }` | `?page=&size=&sort=-col&filter[col]=` (size max 500) → `{ data, meta }`. Sort and filter fields must be `sortable` / `filterable` columns of a table panel bound to the provider. |
| `GET ai` | `?limit=` (agent runs) | `?size=` (max 500) |

The extension data-provider SPI does not change: `readTableQuery` still reads `page` / `limit` / `sort` + `dir` / `filter.<col>`, and a paged provider still returns `{ rows, total, page, limit }`. The route translates both ways, so providers shipped by other packages (durable, agent, media, official) keep working as they are. Non-table provider queries (`metric`, drill-downs, a panel's own `data.query`) pass through untouched. The storage SPI (`get` → `{ data, nextCursor, partial? }`, `tags(prefix, { search, limit, offset })`) does not change either. The `telescope_*` MCP dev tools keep their `{ items, next }` contract.

The shared list helpers (`parseCursorParams`, `parsePageParams`, `parseFilterParams`, `resolveSort`, `cursorPage`, `offsetPage`, `ListQueryError`) live in `src/nest/list-api.ts`, a verbatim copy of the Aviary canonical file.

### MCP endpoint removed

Telescope's own MCP endpoint, `POST <path>/api/mcp`, is gone, with the `mcp`, `mcpAuthorize` and `mcpDecorators` options and the `TelescopeMcpController`, `TelescopeMcpServer`, `MCP_TOOLS`, `McpToolSpec`, `McpToolArgs`, `McpToolNotice` and `isMcpToolNotice` exports. Coding agents use the shared Aviary dev MCP endpoint, `/mcp/aviary` (`@dudousxd/nestjs-agent-mcp-server`), where telescope's `telescope_list_entries`, `telescope_get_entry`, `telescope_get_trace`, `telescope_get_waterfall`, `telescope_get_health` and `telescope_diagnose_exception` stay, gated by `authorize`. `summarizeEntry` is still exported.

Before:

```ts
TelescopeModule.forRoot({
  mcp: true,
  authorize: { policy: ConsolePolicy, ability: 'view' },
  mcpAuthorize: authorizeByToken({ token: process.env.TELESCOPE_MCP_TOKEN }),
});
// claude mcp add --transport http telescope https://app.example.com/telescope/api/mcp
```

After:

```ts
TelescopeModule.forRoot({ authorize: { policy: ConsolePolicy, ability: 'view' } });
AgentMcpServerModule.forRoot({ /* … */ }); // serves /mcp/aviary
// claude mcp add --transport http aviary https://app.example.com/mcp/aviary
```
