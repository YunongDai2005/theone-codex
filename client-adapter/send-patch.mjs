import { createHash } from 'node:crypto'

export const SEND_RENDERER_PATH = 'webview/assets/async/182735.bb2cb0d2af.js'
export const SEND_RENDERER_SHA256 = 'ab463aa100bbd1c6306d7b32c9de911db22d9bd03ee7a30f844e32d0069916ce'

// Verified against the installed native turn-start adapter. No DOM guessing, polling,
// replacement of the send result, or waiting for MCP. Empty/tool-only turns are ignored.
export function patchSendRenderer(source) {
  if (createHash('sha256').update(source).digest('hex') !== SEND_RENDERER_SHA256) throw Error('Unsupported native send renderer: SHA-256 mismatch')
  const anchor = 'this.executeTurnStart=this.streamRecovery.wrapTurnStart(X)'
  if (source.split(anchor).length !== 2) throw Error('Unsupported native send seam')
  return source.replace(anchor, `this.executeTurnStart=((send,hostId)=>(...args)=>{
    try{const request=args[1]?.request;
      const text=request?.input?.filter(item=>item.type==="text").map(item=>item.text).join("\\n");
      if(text?.trim()&&!request.toolOutput)window.dispatchEvent(new CustomEvent("theone-user-send",{detail:{hostId,threadId:request.threadId??args[0],text}}));
    }catch{}return send(...args);
  })(this.streamRecovery.wrapTurnStart(X),this.hostId)`)
}
