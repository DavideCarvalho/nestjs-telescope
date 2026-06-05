// GitHub Pages serves the site under /<repo>, so the Pages build bakes in
// NEXT_BASE_PATH=/nestjs-telescope. A plain `<img src="/screenshots/...">`
// (and even `next/image` with `unoptimized`, which passes the src through
// untouched) would 404 under that prefix — so we prepend the basePath here at
// export time. Local/root builds leave it empty.
const basePath = process.env.NEXT_BASE_PATH ?? '';

/**
 * Dashboard screenshot for the docs. Pre-sized 1440×900 captures stored in
 * `public/screenshots/`, served basePath-aware in the static export.
 */
export function Screenshot({ src, alt }: { src: string; alt: string }) {
  return (
    // biome-ignore lint/a11y/useAltText: alt is provided via the `alt` prop.
    <img
      src={`${basePath}${src}`}
      alt={alt}
      width={1440}
      height={900}
      loading="lazy"
      decoding="async"
      className="rounded-lg border border-fd-border shadow-sm my-6 w-full h-auto"
    />
  );
}
