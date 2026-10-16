// Run with Node 22+ and Chromium installed; no third-party test dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');

(async()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'sourcing-browser-'));
  const web=path.resolve(__dirname,'../web');
  const server=http.createServer((request,response)=>{
    const relative=decodeURIComponent(request.url.split('?')[0]);
    // Synthetic response validates browser wiring; it is not a live scrape fixture.
    if(relative==='/config.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end('window.SOURCING_BACKEND={available:true};');return;}
    if(relative==='/api/collect'){
      const blocked=new URL(request.url,'http://test').searchParams.get('q')==='blocked';
      const base={shipping:null,url:'https://example.com/product',observed_at:'2026-01-01T00:00:00Z',price_kind:'fixed'};
      const products=blocked?[]:[{...base,id:'mock-1',source_id:'oliveyoung',source:'올리브영',country:'한국',currency:'KRW',title:'모의 공개 상품',price:10000},{...base,id:'mock-2',source_id:'daiso',source:'다이소',country:'한국',currency:'KRW',title:'모의 옵션 가격',price:5000,price_kind:'from'},{...base,id:'mock-3',source_id:'shopee_ph',source:'Shopee 필리핀',country:'필리핀',currency:'PHP',title:'Mock foreign product',price:500}];
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({query:'fixture',products,sources:[{source_id:'coupang',source:'쿠팡',status:'network_blocked',message:'모의 프록시 차단'}],message:blocked?'모의 수집 실패':'브라우저 시험용 모의 응답'}));return;
    }
    const file=path.resolve(web,'.'+(relative==='/'?'/index.html':relative));
    if(!file.startsWith(web+path.sep)||!fs.existsSync(file)){response.writeHead(404);response.end();return;}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'}[path.extname(file)]||'application/octet-stream';
    response.writeHead(200,{'Content-Type':mime+'; charset=utf-8'});response.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=spawn(process.env.CHROMIUM_PATH||'chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+temporary,'about:blank'],{stdio:'ignore'});
  let socket;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function waitFor(callback,label){const end=Date.now()+15000;while(Date.now()<end){const value=await callback();if(value)return value;await delay(100);}throw Error('Timeout: '+label);}
  try{
    const active=path.join(temporary,'DevToolsActivePort');
    await waitFor(()=>fs.existsSync(active),'Chromium startup');
    const port=fs.readFileSync(active,'utf8').split('\n')[0];
    const target=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();
    socket=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let nextId=0;const waiting=new Map();const errors=[];
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const item=waiting.get(message.id);if(item){waiting.delete(message.id);if(message.error)item.reject(Error(message.error.message));else item.resolve(message.result);}}else if(message.method==='Runtime.exceptionThrown'){errors.push(message.params.exceptionDetails.text);}});
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;waiting.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    await send('Runtime.enable');await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:origin+'/'});
    await waitFor(()=>evaluate('Boolean(document.getElementById("startup")?.hidden)'),'site startup');
    await waitFor(()=>evaluate('[...document.images].every(image=>image.complete&&image.naturalWidth>0)'),'brand artwork loads');
    assert.equal(await evaluate('document.querySelectorAll("#product-results tr").length'),0);
    await evaluate('document.getElementById("demo").click()');
    assert.equal(await evaluate('document.querySelectorAll("#top3 .pick").length'),3);
    assert.equal(await evaluate('document.querySelectorAll("#product-results tr").length'),4);
    assert.equal(await evaluate('document.getElementById("demo-banner").hidden'),false);
    await send('Page.reload');
    await waitFor(()=>evaluate('Boolean(document.getElementById("startup")?.hidden)'),'reload with saved state');
    await waitFor(()=>evaluate('[...document.images].every(image=>image.complete&&image.naturalWidth>0)'),'saved page brand artwork');
    assert.equal(await evaluate('document.querySelectorAll("#product-results tr").length'),4);
    const desktop=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync('/tmp/sourcing-site-desktop.png',Buffer.from(desktop.data,'base64'));
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate('window.scrollTo({top:0,behavior:"instant"})');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);
    const mobile=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync('/tmp/sourcing-site-mobile.png',Buffer.from(mobile.data,'base64'));
    await evaluate('document.getElementById("keyword").value="선크림";document.getElementById("search").click()');
    assert.equal(await evaluate('document.querySelectorAll("#search-links a").length'),8);
    await waitFor(()=>evaluate('document.querySelectorAll("#collected-results tr").length===3'),'automatic collector fixture');
    assert.match(await evaluate('document.getElementById("source-status").textContent'),/네트워크 차단/);
    assert.equal(await evaluate('document.querySelectorAll("#collected-results button:disabled").length'),1);
    assert.match(await evaluate('document.getElementById("collected-results").textContent'),/미확인/);
    await evaluate(`[...document.querySelectorAll('#collected-results tr')].find(row=>row.textContent.includes('모의 공개 상품')).querySelector('button').click()`);
    assert.equal(await evaluate('document.getElementById("product-price").value'),'10000');
    assert.equal(await evaluate('document.getElementById("product-shipping").value'),'');
    await evaluate(`[...document.querySelectorAll('#collected-results tr')].find(row=>row.textContent.includes('Mock foreign')).querySelector('button').click()`);
    assert.equal(await evaluate('document.getElementById("offer-market").value'),'PH_SHOPEE');
    assert.equal(await evaluate('document.getElementById("offer-sale_price").value'),'500');
    assert.equal(await evaluate('document.getElementById("offer-confirmed").checked'),false);
    await evaluate('document.getElementById("keyword").value="blocked";document.getElementById("search").click()');
    await waitFor(()=>evaluate('!document.getElementById("search").disabled'),'blocked collector fixture');
    assert.equal(await evaluate('document.getElementById("collected-table").hidden'),true);
    await evaluate('window.confirm=()=>true;document.getElementById("clear").click()');
    assert.equal(await evaluate('document.querySelectorAll("#product-results tr").length'),0);
    await evaluate(`document.getElementById('product-title').value='수동 검증 상품';document.getElementById('product-group').value='manual';document.getElementById('product-price').value='10000';document.getElementById('product-shipping').value='0';document.getElementById('product-form').requestSubmit()`);
    assert.equal(await evaluate('document.querySelectorAll("#product-results tr").length'),1);
    await evaluate(`for(const [key,value] of Object.entries({group:'manual',market:'PH_SHOPEE',sale_price:1000,exchange_rate:20,fee_pct:10,tax_pct:5,outbound_shipping:3000,other_cost:0,refund_pct:2}))document.getElementById('offer-'+key).value=value;document.getElementById('offer-confirmed').checked=true;document.getElementById('offer-form').requestSubmit()`);
    assert.equal(await evaluate('document.querySelectorAll("#top3 .pick").length'),1);
    assert.equal(await evaluate('document.getElementById("stat-profit").textContent'),'3,100원');
    await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:temporary});
    await evaluate('document.getElementById("comparison-export").click()');
    const downloaded=path.join(temporary,'PH-VN-comparison.xlsx');
    await waitFor(()=>fs.existsSync(downloaded)&&fs.statSync(downloaded).size>0,'XLSX browser download');
    fs.copyFileSync(downloaded,'/tmp/sourcing-web-browser.xlsx');
    await evaluate(`{const file=new File(['title,price,source,shipping,group,url\\nCSV검증,9000,CSV몰,0,manual,\\n'],'import.csv',{type:'text/csv'});const transfer=new DataTransfer();transfer.items.add(file);document.getElementById('csv-file').files=transfer.files;document.getElementById('csv-file').dispatchEvent(new Event('change'));}`);
    await waitFor(()=>evaluate('document.querySelectorAll("#product-results tr").length===2'),'CSV import');
    assert.equal(await evaluate('document.querySelectorAll("#top3 .pick").length'),1);
    assert.equal(await evaluate('document.getElementById("stat-profit").textContent'),'4,100원');
    assert.deepEqual(errors,[]);
    console.log('Browser checks passed: synthetic collector response, blocked/unknown-shipping/from-price handling, domestic/foreign price insertion, startup, TOP3, saved reload, mobile layout, exact profit, XLSX download, CSV import. Live scraping not asserted.');
  }finally{
    if(socket)socket.close();browser.kill('SIGTERM');await new Promise(resolve=>{if(browser.exitCode!==null)resolve();else browser.once('exit',resolve);});await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
