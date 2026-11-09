import { chromium } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { TheOneService } from '../src/service.ts'
import { createMcpServer } from '../src/mcp-server.ts'

await mkdir('.theone', { recursive: true })
const root = await mkdtemp(resolve('.theone/native-ui-validation-'))
const service = new TheOneService({ dataDir: root })
const topicId = service.createTopic('旅行 <img src=x onerror=alert(1)>')
const mcp = createMcpServer(service), client = new Client({ name: 'native-ui-test', version: '1' })
const [a, b] = InMemoryTransport.createLinkedPair()
await mcp.connect(a); await client.connect(b)
let browser, http
const received = []
try {
  const tools = (await client.listTools()).tools
  const launch = tools.find(t => t._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'global'))
  const panel = tools.find(t => t._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'thread'))
  assert.ok(launch && panel && launch.name !== panel.name, 'Native launcher must be distinct from topic panel')
  const resource = await client.readResource({ uri: launch._meta.ui.resourceUri })
  const parent = `<!doctype html><meta charset="utf-8"><style>html,body,iframe{border:0;width:100%;height:100%;margin:0;display:block}</style><iframe title="TheOne" src="/app"></iframe><script>
    const frame=document.querySelector('iframe'), query=new URLSearchParams(location.search);
    addEventListener('message',async e=>{
      if(e.source!==frame.contentWindow || e.data?.jsonrpc!=='2.0')return;
      const {id,method,params}=e.data;if(id===undefined)return;
      try{
        let result;
        if(method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'native bridge test',version:'1'},hostCapabilities:{serverTools:{},...(query.has('unsupported')?{}:{message:{text:{}},experimental:{'openai/message':{}}})},hostContext:{theme:'dark',displayMode:'fullscreen',availableDisplayModes:['fullscreen','inline']}};
        else if(method==='tools/call')result=await window.callTheOne(params);
        else if(method==='ui/message'){await window.recordNativeDraft(params);result={};}
        else throw Error('Unsupported test host method: '+method);
        frame.contentWindow.postMessage({jsonrpc:'2.0',id,result},location.origin);
        if(method==='ui/initialize'){
          const initial=await window.callTheOne({name:query.has('panel')?'${panel.name}':'${launch.name}',arguments:{}});
          frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:initial},location.origin);
          frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:initial},location.origin);
        }
      }catch(error){frame.contentWindow.postMessage({jsonrpc:'2.0',id,error:{code:-32603,message:String(error)}},location.origin);}
    });
  </script>`
  http=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url==='/app'?resource.contents[0].text:parent)})
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve))
  browser=await chromium.launch({channel:'msedge',headless:true})
  const page=await browser.newPage({viewport:{width:420,height:780}}), errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.exposeFunction('callTheOne',args=>client.callTool(args))
  await page.exposeFunction('recordNativeDraft',params=>{received.push(params)})
  const base=`http://127.0.0.1:${http.address().port}`
  await page.goto(base)
  const ui=page.frameLocator('iframe')
  await ui.getByText('已打开原生聊天', {exact:true}).waitFor()
  assert.equal(received.length,1,'Repeated tool results must not open duplicate drafts')
  assert.deepEqual(received[0]._meta['openai/message'],{target:'new',send:false})
  assert.match(received[0].content[0].text,/TheOne/)
  assert.equal(await ui.locator('textarea').count(),0,'The plugin must not ship its own chat composer')
  assert.equal(service.status().runs.length,0,'Opening a native draft must not execute a worker')
  await page.goto(base+'/?panel')
  await ui.getByRole('button',{name:'切换到旅行 <img src=x onerror=alert(1)>',exact:true}).click()
  await ui.getByText('已放入当前聊天输入框', {exact:true}).waitFor()
  assert.deepEqual(received[1]._meta['openai/message'],{target:'active',send:false})
  assert.ok(JSON.stringify(received[1].content).includes(topicId))
  assert.equal(await ui.locator('img').count(),0)
  await ui.getByRole('button',{name:'新话题',exact:true}).click()
  await ui.getByLabel('话题名称',{exact:true}).fill('做饭')
  await ui.getByRole('button',{name:'在原生聊天中开始',exact:true}).click()
  await ui.getByRole('button',{name:'在原生聊天中开始',exact:true}).waitFor({state:'hidden'})
  assert.equal(service.listTopics().length,2)
  assert.deepEqual(received[2]._meta['openai/message'],{target:'active',send:false})
  await page.goto(base+'/?unsupported')
  await ui.getByText('当前宿主未提供打开原生聊天的接口', {exact:true}).waitFor()
  assert.equal(received.length,3,'Unsupported host must never silently send into an unintended thread')
  assert.deepEqual(errors,[])
  await writeFile('evidence/native-ui-validation.json',JSON.stringify({at:new Date().toISOString(),realMcpService:true,simulatedNativeHost:true,desktopUiTested:false,
    checks:['native new draft metadata','duplicate notification guard','no replacement chat composer','topic selection to active draft','new topic to active draft','HTML title safety','unsupported host fails closed','no worker execution on open']},null,2)+'\n')
  console.log('Native chat bridge: 8 checks passed; actual desktop navigation remains to be verified.')
}finally{await browser?.close();if(http)await new Promise(resolve=>http.close(resolve));await client.close();await mcp.close();await service.close()}
