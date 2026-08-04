---
'@dudousxd/nestjs-telescope-ui': minor
'@dudousxd/nestjs-telescope': minor
---

Rebuild the chart cards on a vendored shadcn chart layer, and give them a legend, a brush and
drill-down.

Every chart in the console — the Overview throughput and by-type areas, the queues bars, the entry
insights, and every chart-shaped extension panel — was hand-rolled Recharts: each card restated its
own grid stroke, axis stroke, tick style and the three `contentStyle`/`labelStyle`/`itemStyle`
objects that make up Recharts' single line of tooltip text. Series colours lived in two places, and
chrome colours in seven.

- **`src/react/ui/chart.tsx`** joins the vendored primitives: `ChartContainer`, `ChartTooltip`,
  `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent` and the `ChartConfig` type, retuned to
  the Aviary tokens. Two departures from upstream shadcn, both deliberate: chart chrome is styled by
  selecting Recharts' own class names off the container (a stylesheet rule beats an SVG presentation
  attribute), and the per-series `--color-<key>` custom properties are set inline instead of through
  shadcn's `dangerouslySetInnerHTML` style tag — a config that can come from an extension-authored
  dashboard spec should not reach an HTML-injection-shaped API.
- **`chart-theme.ts` is now the only place a series colour is decided**, and the chrome constants it
  used to export are deprecated rather than removed. Breakdown segments resolve through the same
  entry-type hues as everything else, so an `exception` segment is no longer amber in a donut and red
  in the chart beside it.
- **Rich hover cards** everywhere: label row, one row per series with its own swatch, configured name
  and formatted value. Everything read out of a Recharts payload goes through runtime guards — a
  provider can return anything, and a tooltip rendering `[object Object]` is a bug nobody notices
  until it is in a screenshot.
- **Clickable legends** on the multi-series charts: an entry toggles its series, which restacks the
  rest. With six entry types stacked, switching the big ones off is the only way to read the small
  ones. The entries are the vendored `Button` with `aria-pressed`, not bare `<button>`s.
- **Brush on the timeseries charts**, so a long window can be narrowed in place. It appears once a
  series passes 24 points and can be forced either way with `brush`; below that it is a scrollbar for
  a page that already fits.
- **Drill-down.** A chart-shaped panel that declares `drilldown: { param }` becomes clickable: the
  click sets one dashboard-wide selection, every panel re-resolves with that param merged onto its
  own `data.query`, and a chip in the header says what is filtered (clicking the same item again, or
  the chip's Clear, undoes it). A panel that declares no `drilldown` gets no click handler at all, so
  every dashboard shipping today behaves exactly as before. The cards themselves take a typed
  `onSelect(selection)` and know nothing about dashboards; `BarChartCard.onBarClick` still fires and
  is deprecated in favour of it.
- Two bugs the rewrite surfaced: a `gauge` panel drew a full half-dial whatever it was reporting
  (with one datum and no explicit polar domain, Recharts scales the arc to the value itself), and a
  `distribution` panel's percentile chips pushed its chart out of the card by exactly their own
  height.
