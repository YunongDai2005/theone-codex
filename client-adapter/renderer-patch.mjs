import { createHash } from 'node:crypto'
import { BRAND_CSS, CELL_COMPONENT } from './brand.mjs'
import { DESKTOP_RUNTIME, DESKTOP_CSS } from './desktop-runtime.mjs'
import { PLUGIN_MENTION } from './native-host.mjs'

export const RENDERER_PATH = 'webview/assets/async/499225.6d2e47bea2.js'
export const RENDERER_SHA256 = '80f7a6b651f9f56ac97463123d72963c2a78570f6f0162c75d0d6d9d0a03f074'
export const ADAPTER_VERSION = '0.4.2'
export const THEONE_PROMPT = PLUGIN_MENTION

export function patchRenderer(source) {
  if (source.includes('function TheOneClientEntry(')) throw new Error('Client already adapted')
  if (createHash('sha256').update(source).digest('hex') !== RENDERER_SHA256) throw new Error('Unsupported client renderer: SHA-256 mismatch')
  const start = source.indexOf('function dT(e){'), end = source.indexOf('function dE(e){', start)
  if (start < 0 || end < start) throw new Error('Unsupported native navigation component')
  const original = source.slice(start, end)
  const anchor = 'children:[n,c,a,u,s]'
  if (original.split(anchor).length !== 2) throw new Error('Unsupported native New chat placement')
  const entry = `${CELL_COMPONENT}${DESKTOP_RUNTIME}function TheOneClientEntry(){
    const scope=(0,l.gh)(A.u);
    const preview=(0,c.useContext)(cq.I).previewNavigationState;
    const desktop=TheOneDesktop.useDesktop({React:c,scope,modules:n,preview,css:${JSON.stringify(DESKTOP_CSS)},startDraft:(draft,created)=>{(0,a$.ub)(scope,{
      canStartProjectlessChat:scope.get(dt.T$),currentThreadKey:scope.get(tF.oN),localProjectActionsEnabled:scope.get(dt.Lk),
      startNewConversation:options=>{(0,aB.startNewConversation)(scope,{...options,...draft});created()},
      startNewConversationInProject:project=>{(0,dx.E)(scope,project,draft);created()}
    })}});
    const active=desktop.active;
    const marker=(0,c.useRef)(null);
    (0,c.useEffect)(()=>{const style=document.createElement("style");style.dataset.theoneBrand="${ADAPTER_VERSION}";style.textContent=${JSON.stringify(BRAND_CSS)};document.head.append(style);return()=>style.remove()},[]);
    (0,c.useEffect)(()=>{
      const button=marker.current?.closest("button");if(!button||!active)return;
      const move=event=>{if(event.pointerType==="touch")return;const bounds=button.getBoundingClientRect();button.style.setProperty("--one-pointer-x",(event.clientX-bounds.left)+"px");button.style.setProperty("--one-pointer-y",(event.clientY-bounds.top)+"px");button.dataset.oneTracking="true"};
      const leave=()=>{delete button.dataset.oneTracking};
      button.addEventListener("pointermove",move,{passive:true});button.addEventListener("pointerleave",leave);button.addEventListener("pointercancel",leave);
      return()=>{button.removeEventListener("pointermove",move);button.removeEventListener("pointerleave",leave);button.removeEventListener("pointercancel",leave);leave();button.style.removeProperty("--one-pointer-x");button.style.removeProperty("--one-pointer-y")}
    },[active]);
    const now=new Date(),spooky=now.getMonth()===9&&now.getDate()>=30;
    const label=(0,r.jsxs)("span",{ref:marker,className:"theone-nav",translate:"no","data-wide":true,"data-active":active,children:[
      (0,r.jsx)("span",{className:"theone-symbol-wrap",children:(0,r.jsx)(TheOneCellSymbol,{state:active?"active":"idle",spooky})}),
      (0,r.jsxs)("span",{className:"theone-entry-copy",children:[
        (0,r.jsxs)("span",{className:"theone-entry-title",children:[(0,r.jsxs)("span",{className:"theone-wordmark",translate:"no",children:[(0,r.jsx)("span",{className:"theone-word-the",children:"The"}),(0,r.jsxs)("span",{className:"theone-word-one",children:["One",(0,r.jsx)("span",{className:"theone-word-dot"})]})]}),(0,r.jsx)("span",{className:"theone-entry-label",children:"主聊天"})]}),
        (0,r.jsx)("span",{className:"theone-entry-sub",children:desktop.subtitle})
      ]})
    ]});
    return(0,r.jsxs)(c.Fragment,{children:[(0,r.jsx)(s1.jl,{label,onClick:desktop.open,onContextMenu:desktop.contextMenu,"aria-label":"TheOne",excludeFromNavigation:true,"data-theone-native-entry":"${ADAPTER_VERSION}",title:"TheOne · 主聊天"}),desktop.controls]})
  }`
  const patched = original.replace(anchor, 'children:[n,g==="codex"?(0,r.jsx)(TheOneClientEntry,{}):null,c,a,u,s]')
  const railStart = source.indexOf('function d$(e){')
  const railEnd = source.indexOf('(0,tX._)(async()=>()=>null);', railStart)
  if (railStart < end || railEnd < railStart) throw new Error('Unsupported navigation-rail component')
  const rail = source.slice(railStart, railEnd)
  const railAnchor = 'children:[t,n,a]'
  if (rail.split(railAnchor).length !== 2) throw new Error('Unsupported navigation-rail New chat placement')
  const patchedRail = rail.replace(railAnchor, 'children:[t,c==="codex"?(0,r.jsx)(TheOneClientEntry,{}):null,n,a]')
  return source.slice(0, start) + entry + patched + source.slice(end, railStart) + patchedRail + source.slice(railEnd)
}
