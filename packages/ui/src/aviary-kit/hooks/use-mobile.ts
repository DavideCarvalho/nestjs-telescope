// Vendored from shadcn/ui, registry style "base-vega" (Base UI flavour), item "use-mobile".
// Fetched 2026-11-13 from https://ui.shadcn.com/r/styles/base-vega/use-mobile.json. Local edits are marked "aviary:".
import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    // aviary: test DOMs (jsdom) have no matchMedia; fall back to the width read above.
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return !!isMobile;
}
