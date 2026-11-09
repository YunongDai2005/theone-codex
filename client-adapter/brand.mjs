import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

// Keep the original DSH implementation inspectable; only bind it to this host's React.
const cell = transformSync(readFileSync(new URL('./dsh-cell.ts', import.meta.url), 'utf8'), { loader: 'ts', target: 'es2022' }).code
export const CELL_COMPONENT = `const TheOneCellSymbol=(()=>{const h=c.createElement,useRef=c.useRef,useEffect=c.useEffect;${cell};return CellSymbol;})();`

const originalCss = readFileSync(new URL('./dsh-button.css', import.meta.url), 'utf8')
export const BRAND_CSS = originalCss.replaceAll('[data-ds-dark-theme]', ':is(.dark,[data-theme="dark"],[data-color-scheme="dark"])') + `
/* Codex host binding: preserve DSH's 64px card, typography, colors and spacing. */
button[data-theone-native-entry]{
  --dsw-alias-label-primary:var(--color-text-primary,CanvasText);
  --dsw-alias-label-secondary:var(--color-text-secondary,GrayText);
  width:100%;height:auto;min-height:64px;padding:12px 10px;
  margin-top:4px;margin-bottom:18px;white-space:normal
}
button[data-theone-native-entry]>div{overflow:visible;min-width:0;flex:1}
button[data-theone-native-entry]>div>.text-fade-truncate{display:block;overflow:visible;white-space:normal;flex:1}
button[data-theone-native-entry]:focus-visible{outline:2px solid var(--one-accent);outline-offset:2px}
`
