(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.SourcingCore;
  const X = window.SourcingXlsx;
  const F = window.SourcingFx;
  if (!C || !X || !F) { $('startup').textContent = '기능 파일을 불러오지 못했습니다. 새로고침해 주세요.'; return; }
  const storageKey = 'sourcing-radar-web-v1';
  const labels = {sale_price:'사입 분석표의 원화 판매가', fee_pct:'사입 분석표의 수수료 (%)', tax_pct:'사입 분석표의 세금 충당 (%)', purchase_shipping:'추가 사입 배송료 (원)', outbound_shipping:'사입 분석표 발송비 (원)', packaging:'공통 포장비 (원)', other_cost:'사입 분석표 기타비 (원)', refund_pct:'사입 분석표 반품 충당 (%)', min_roi:'추천 목표 수익률 (%)'};
  const productKeys = ['title', 'source', 'price', 'shipping', 'group', 'url'];
  const offerKeys = ['group','market','sale_price','exchange_rate','fee_pct','tax_pct','outbound_shipping','other_cost','refund_pct','sale_url'];
  let state = {version:1, rows:[], offers:[], settings:{...C.DEFAULTS}, metric:'profit', demo:false};
  let current = null;
  let storageAvailable = true;
  let latestFx = null;
  let fxBusy = false;
  let lastFxAttempt = 0;
  let excludedFxOffers = 0;
  let inputCurrency = 'PHP';
  const money = n => n == null ? '—' : Math.round(n).toLocaleString('ko-KR') + '원';
  const percent = n => n == null ? '—' : n.toFixed(1) + '%';
  const text = (tag, value, className) => { const el=document.createElement(tag); el.textContent=value; if(className)el.className=className; return el; };
  function message(value, error=false) { $('message').textContent=value; $('message').classList.toggle('error',error); }
  function guard(callback) { return async event => { try { await callback(event); } catch (error) { message(error.message || '처리하지 못했습니다. 입력 내용을 확인하세요.',true); } }; }
  function readSettings() { return {...Object.fromEntries(Object.keys(labels).map(key=>[key,$('common-'+key).value])),exchange_rate:1}; }
  function quoteFor(currency) { return F.normalizeResponse(latestFx).rates[currency] || null; }
  function activeOffers() {
    excludedFxOffers=0;
    return state.offers.filter(offer=>{
      if(state.demo||offer.fx_mode!=='naver')return true;
      const rate=quoteFor(C.MARKETS[offer.market].currency);
      if(!rate){excludedFxOffers++;return false;}
      Object.assign(offer,F.makeOfferRate(rate));return true;
    });
  }
  function payload() { return {rows:state.rows,offers:activeOffers(),settings:readSettings(),metric:$('metric').value}; }
  function rateProvenance(offer){
    if(state.demo)return {fx_mode:'demo',fx_source:'예시 환율',fx_observed_at:'',fx_source_url:'',fx_quoted_rate:null,fx_quoted_units:null,fx_rate_type:'예시'};
    if(offer.fx_mode==='naver')return Object.fromEntries(['fx_mode','fx_source','fx_observed_at','fx_source_url','fx_quoted_rate','fx_quoted_units','fx_rate_type'].map(key=>[key,offer[key]??null]));
    return {fx_mode:'manual',fx_source:'직접 입력',fx_observed_at:'',fx_source_url:'',fx_quoted_rate:null,fx_quoted_units:null,fx_rate_type:'수동'};
  }
  function cleanRows(input, settings) { return C.analyze({rows:input,settings}).rows.map(row=>({...Object.fromEntries(productKeys.map(key=>[key,row[key]])),group:row.group.trim()})); }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({...state,settings:readSettings(),metric:$('metric').value})); }
    catch (_) { storageAvailable=false; $('storage-note').textContent='브라우저 저장 공간을 사용할 수 없습니다. 창을 닫기 전에 작업 백업을 저장하세요.'; }
  }
  function newCell(row, value, className) { const cell=text('td',value,className); row.append(cell); return cell; }
  function showProducts(analysis) {
    $('product-results').replaceChildren();
    for(const product of analysis.rows) {
      const tr=document.createElement('tr');
      newCell(tr, product.rank ? product.rank+'위' : '—');
      const name=newCell(tr,'','name');
      if(product.url){ const link=text('a',product.title);link.href=product.url;link.target='_blank';link.rel='noopener noreferrer';name.append(link); }
      else name.append(text('span',product.title));
      name.append(text('small',product.group||'동일상품 그룹 없음'));
      newCell(tr,product.source);newCell(tr,money(product.purchase_total));newCell(tr,money(product.profit),product.profit>=0?'positive':'negative');
      const cell=newCell(tr,'');const remove=text('button','삭제');remove.type='button';remove.setAttribute('aria-label',product.title+' 삭제');remove.onclick=guard(()=>{
        const index=state.rows.findIndex(row=>row.title===product.title&&row.source===product.source&&row.group===product.group&&Number(row.price)===product.price&&Number(row.shipping||0)===product.shipping);
        if(index>=0)state.rows.splice(index,1);refresh();message('사입 후보를 삭제했습니다.');
      });cell.append(remove);$('product-results').append(tr);
    }
    $('products-empty').hidden=analysis.rows.length>0;
    $('stat-count').replaceChildren(text('span',String(state.rows.length)),text('small','개'));
    $('groups').replaceChildren(...[...new Set(state.rows.map(row=>row.group).filter(Boolean))].map(group=>{const option=document.createElement('option');option.value=group;return option;}));
  }
  function showOffers() {
    $('offer-list').replaceChildren();
    state.offers.forEach((offer,index)=>{
      const market=C.MARKETS[offer.market];const item=document.createElement('div');item.className='offer-item';const info=document.createElement('div');
      info.append(text('strong',offer.group+' · '+market.country+' '+market.platform));
      const rateNote=!state.demo&&offer.fx_mode==='naver'&&!quoteFor(market.currency)?'네이버 환율 조회 대기 · 계산 제외':F.describeOffer(offer,state.demo);
      info.append(text('small',Number(offer.sale_price).toLocaleString('ko-KR')+' '+market.currency+' / '+(offer.confirmed?'시세 사용자 확인':'시세 미확인')+' / '+rateNote));
      const remove=text('button','삭제','danger');remove.type='button';remove.onclick=guard(()=>{state.offers.splice(index,1);refresh();message('판매 시나리오를 삭제했습니다.');});item.append(info,remove);$('offer-list').append(item);
    });
    $('offers-empty').hidden=state.offers.length>0;
    $('stat-offers').replaceChildren(text('span',String(state.offers.length)),text('small','개'));
  }
  function showComparison(data) {
    $('top3').replaceChildren();$('comparison-results').replaceChildren();
    for(const product of data.top){
      const card=document.createElement('article');card.className='pick';
      card.append(text('span','TOP '+product.recommendation_rank,'rank'),text('h3',product.title),text('p',product.country+' '+product.platform+' · 사입 '+product.source),text('strong',money(product.profit)),text('small','수익률 '+percent(product.roi_pct)));$('top3').append(card);
    }
    for(const product of data.rows.slice(0,300)){
      const tr=document.createElement('tr');
      [product.recommendation_rank?product.recommendation_rank+'위':'—',product.title+' / '+product.group,product.source,product.country+' '+product.platform,Number(product.sale_price).toLocaleString('ko-KR')+' '+product.currency,money(product.total_cost),money(product.profit),percent(product.roi_pct),product.confirmed?'사용자 확인':'미확인',product.exchange_rate+' 원 / '+product.fx_source].forEach((value,index)=>newCell(tr,value,index===6?(product.profit>=0?'positive':'negative'):''));
      $('comparison-results').append(tr);
    }
    $('recommendations-empty').hidden=data.top.length>0;
    if(data.rows.length&&!data.top.length)$('recommendations-empty').replaceChildren(text('strong','추천 조건을 충족하는 상품이 없습니다'),text('p','시세 확인 여부, 순이익과 목표 수익률을 확인하세요.'));
    else if(!data.rows.length)$('recommendations-empty').replaceChildren(text('strong','수익을 비교할 준비가 되셨나요?'),text('p','사입 후보와 판매 시나리오를 추가하면 조건에 맞는 상품을 추천합니다.'));
    $('compare-note').textContent=(excludedFxOffers?'네이버 환율을 확인하지 못한 '+excludedFxOffers+'개 시나리오는 계산에서 제외했습니다. ':'')+(data.unmatched_groups.length?'사입 후보가 없는 그룹: '+data.unmatched_groups.join(', ')+'. ':'')+(data.rows.length>300?'비교표는 앞의 300개 조합을 표시합니다. 엑셀에는 모든 조합을 저장합니다.':'');
    $('stat-profit').textContent=data.rows.length?money(data.rows.reduce((best,row)=>Math.max(best,row.profit),-Infinity)):'—';
  }
  function refresh() {
    const input=payload();const analysis=C.analyze(input);const comparison=C.compare(input);
    comparison.rows.forEach(row=>Object.assign(row,rateProvenance(input.offers[row.offer_index])));
    current={analysis,comparison};state.settings=analysis.settings;state.metric=input.metric;
    showProducts(analysis);showOffers();showComparison(comparison);$('demo-banner').hidden=!state.demo;persist();
  }
  function download(filename, blob) {const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function settingsRows() {
    return [['항목','값'],...Object.entries(readSettings()),['추천 기준',$('metric').value],['데모 여부',state.demo],['계산 기준','매출=판매가×환율. 수익률=순이익÷(사입 합계+발송비+포장비+기타비)×100.'],['세금','매출 비례 충당 추정. 실제 부가세·소득세·관세 정산이 아닙니다.'],['시세','사용자 입력 또는 수집 표시가. 수요·판매량은 검증하지 않았습니다.'],['환율','시나리오별 네이버 자동/수동/예시 구분. VND 100단위 고시는 1단위로 나눠 적용.'],['환율 미조회로 계산 제외',excludedFxOffers]];
  }
  function tableRows(rows, fields){return [fields.map(([,label])=>label),...rows.map(row=>fields.map(([key])=>row[key]??null))];}
  const productFields=[['rank','그룹 내 가격순'],['group','동일상품 그룹'],['title','상품'],['source','사입처'],['price','사입가 KRW'],['shipping','판매처 배송료'],['purchase_total','사입 합계 KRW'],['revenue','매출 KRW'],['fee','수수료'],['tax','세금 충당'],['refund_reserve','반품 충당'],['total_cost','전체비용'],['profit','순이익'],['roi_pct','수익률 %'],['margin_pct','마진율 %'],['break_even','손익분기 매출 KRW'],['url','사입 링크']];
  const comparisonFields=[['recommendation_rank','추천 상품 순위'],['group','동일상품 그룹'],['title','상품'],['source','사입처'],['purchase_total','사입 합계 KRW'],['country','판매 국가'],['platform','판매 플랫폼'],['currency','현지 통화'],['sale_price','현지 판매가'],['exchange_rate','환율 KRW/현지통화'],['revenue','매출 KRW'],['fee','수수료 KRW'],['tax','세금 충당 KRW'],['refund_reserve','반품 충당 KRW'],['total_cost','전체비용 KRW'],['profit','순이익 KRW'],['roi_pct','수익률 %'],['margin_pct','마진율 %'],['confirmed','시세 사용자 확인'],['url','사입 링크'],['sale_url','판매 시세 링크']];
  comparisonFields.push(['fx_mode','환율 방식'],['fx_source','환율 출처'],['fx_observed_at','네이버 조회시각 UTC'],['fx_quoted_rate','고시 단위 표시값'],['fx_quoted_units','고시 통화 단위'],['fx_rate_type','환율 구분'],['fx_source_url','환율 원본 링크']);

  // Build common inputs before restoring saved work.
  for(const [key,label] of Object.entries(labels)){
    const wrapper=text('label',label);const input=document.createElement('input');Object.assign(input,{id:'common-'+key,type:'number',min:'0',step:'any',value:C.DEFAULTS[key]});if(['fee_pct','tax_pct','refund_pct'].includes(key))input.max='100';wrapper.append(input);$('common-fields').append(wrapper);
    input.addEventListener('change',guard(()=>{try{refresh();message('비용 설정을 반영했습니다.');}catch(error){current=null;$('top3').replaceChildren();$('comparison-results').replaceChildren();$('stat-profit').textContent='—';throw error;}}));
  }
  for(const [key,market] of Object.entries(C.MARKETS)){const option=text('option',market.country+' / '+market.platform+' ('+market.currency+')');option.value=key;$('offer-market').append(option);}
  function syncFxInput(){
    const currency=C.MARKETS[$('offer-market').value].currency;const automatic=$('fx-mode').value==='naver';const input=$('offer-exchange_rate');
    $('currency-label').textContent=currency;input.readOnly=automatic;
    if(automatic){const rate=quoteFor(currency);input.value=rate?rate.krw_per_unit:'';input.placeholder='네이버 환율 조회 대기';$('fx-input-note').textContent=rate?'네이버 매매기준율 · 조회 '+observed(rate.observed_at):'확인된 네이버 환율이 있어야 자동 시나리오를 추가할 수 있습니다.';}
    else{if(inputCurrency!==currency)input.value='';input.placeholder='적용할 환율 직접 입력';$('fx-input-note').textContent='직접 입력한 환율은 네이버 자동 환율과 구분해 저장합니다.';}
    inputCurrency=currency;
  }
  $('offer-market').addEventListener('change',syncFxInput);
  $('fx-mode').addEventListener('change',syncFxInput);
  $('product-form').addEventListener('submit',guard(event=>{
    event.preventDefault();const row=Object.fromEntries(productKeys.map(key=>[key,$('product-'+key).value]));row.group=row.group.trim();
    state.rows=cleanRows([...state.rows,row],readSettings());refresh();message('사입 후보를 추가했습니다.');$('product-title').value='';$('product-price').value='';
  }));
  $('offer-form').addEventListener('submit',guard(event=>{
    event.preventDefault();const offer=Object.fromEntries(offerKeys.map(key=>[key,$('offer-'+key).value]));offer.group=offer.group.trim();offer.confirmed=$('offer-confirmed').checked;
    if($('fx-mode').value==='naver'){const rate=quoteFor(C.MARKETS[offer.market].currency);if(!rate)throw new Error('네이버 환율을 확인하지 못했습니다. 환율을 다시 조회하거나 직접 입력 방식을 선택하세요.');Object.assign(offer,F.makeOfferRate(rate));}else{offer.fx_mode='manual';offer.fx_source='직접 입력';}
    if(!state.rows.some(row=>row.group===offer.group))throw new Error('같은 그룹의 사입 후보를 먼저 추가하세요.');
    C.compare({...payload(),offers:[...state.offers,offer]});state.offers.push(offer);refresh();message('판매 시나리오와 추천 결과를 반영했습니다.');$('offer-confirmed').checked=false;
  }));
  const sources = {oliveyoung:'올리브영',daiso:'다이소',coupang:'쿠팡',naver:'네이버쇼핑',shopee_ph:'쇼피 필리핀',shopee_vn:'쇼피 베트남',lazada_ph:'Lazada 필리핀',lazada_vn:'Lazada 베트남'};
  for(const [id,name] of Object.entries(sources)){const label=text('label',name,'checkbox');const input=document.createElement('input');input.type='checkbox';input.value=id;input.checked=true;label.prepend(input);$('source-picker').append(label);}
  const backend = window.SOURCING_BACKEND?.available===true;
  $('collector-message').textContent=backend?'검색어를 넣으면 선택한 쇼핑몰의 공개 가격을 서버에서 조회합니다.':'현재 주소에는 자동 검색 서버가 연결되어 있지 않습니다. 자동 수집 웹서버로 배포해야 가격을 조회할 수 있습니다.';
  const observed=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'미확인':new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short'}).format(date);};
  function drawFx(){
    const rates=F.normalizeResponse(latestFx).rates;
    for(const currency of ['PHP','VND']){
      const rate=rates[currency];const key=currency.toLowerCase();
      $('fx-'+key+'-value').textContent=rate?rate.quoted_units+' '+currency+' = '+Number(rate.quoted_rate).toLocaleString('ko-KR',{maximumFractionDigits:6})+' 원':(currency==='VND'?'100':'1')+' '+currency+' = — 원';
      $('fx-'+key+'-time').textContent=rate?'조회 '+observed(rate.observed_at)+(currency==='VND'?' · 계산용 1 VND = '+rate.krw_per_unit+'원':''):'현재 환율 미확인';
    }
    syncFxInput();
  }
  async function refreshFx(){
    if(fxBusy)return;
    if(!backend){$('fx-status').textContent='자동 환율 서버가 연결되지 않았습니다. 서버가 있는 사이트에서 조회할 수 있습니다.';$('fx-status').classList.add('error');drawFx();return;}
    fxBusy=true;lastFxAttempt=Date.now();$('fx-refresh').disabled=true;$('fx-status').textContent='네이버 매매기준율을 조회하고 있습니다…';
    try{
      const response=await fetch('api/exchange-rates',{cache:'no-store',headers:{Accept:'application/json'}});const data=await response.json();if(!response.ok)throw new Error(data.error||'네이버 환율 요청 실패');
      latestFx=data;const normalized=F.normalizeResponse(data);const count=Object.keys(normalized.rates).length;
      $('fx-status').textContent=count===2?'PHP·VND 네이버 매매기준율 자동 적용 · 10분마다 갱신':count===1?'일부 통화만 확인했습니다. 미조회 통화의 자동 시나리오는 계산에서 제외됩니다.':(data.message||'네이버 환율을 확인하지 못했습니다.');$('fx-status').classList.toggle('error',count<2);
    }catch(error){latestFx=null;$('fx-status').textContent='환율 조회 실패: '+error.message+' 임의 환율은 사용하지 않습니다.';$('fx-status').classList.add('error');}
    finally{fxBusy=false;$('fx-refresh').disabled=false;drawFx();refresh();}
  }
  $('fx-refresh').addEventListener('click',guard(refreshFx));
  function showCollected(data){
    $('collected-results').replaceChildren();$('source-status').replaceChildren();
    const statusLabels={ok:'조회됨',empty:'검색 결과 없음',network_blocked:'네트워크 차단',access_denied:'접근 거부',rate_limited:'호출 제한',unsupported_page:'가격 추출 불가',failed:'조회 실패'};
    for(const source of data.sources||[]){const badge=text('span',(source.source||sources[source.source_id]||source.source_id)+' · '+(statusLabels[source.status]||'조회 실패'),'tag');badge.title=source.message||'';$('source-status').append(badge);}
    const products=[...(data.products||[])].sort((a,b)=>a.currency.localeCompare(b.currency)||a.price-b.price);
    for(const product of products){
      const tr=document.createElement('tr');const name=newCell(tr,'','name');const link=text('a',product.title);try{const url=new URL(product.url);if(['http:','https:'].includes(url.protocol)){link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';}}catch(_){}name.append(link);
      newCell(tr,(product.source||sources[product.source_id])+' / '+product.country);newCell(tr,Number(product.price).toLocaleString('ko-KR')+' '+product.currency+(product.price_kind==='from'?'부터':''));newCell(tr,product.shipping==null?'미확인':Number(product.shipping).toLocaleString('ko-KR'));newCell(tr,observed(product.observed_at));
      const action=newCell(tr,'');const button=text('button',product.currency==='KRW'?'사입가 넣기':'현지 판매가 넣기');button.type='button';
      if(product.price_kind==='from'){button.disabled=true;button.textContent='옵션별 가격 확인 필요';}
      button.onclick=()=>{
        if(product.currency==='KRW'){
          for(const [key,value] of Object.entries({title:product.title,group:'',source:['올리브영','다이소','쿠팡','네이버쇼핑'].includes(product.source)?product.source:'기타',price:product.price,shipping:product.shipping==null?'':product.shipping,url:product.url}))$('product-'+key).value=value;
          $('acquired-meta').textContent='자동 조회 '+observed(product.observed_at)+' · 동일상품 그룹과 배송료를 확인한 뒤 추가하세요. 배송료가 없으면 0을 입력합니다.';$('product-form').scrollIntoView({behavior:'smooth',block:'center'});$('product-group').focus();
        }else{
          const market=product.source_id.toUpperCase().replace('SHOPEE_PH','PH_SHOPEE').replace('SHOPEE_VN','VN_SHOPEE').replace('LAZADA_PH','PH_LAZADA').replace('LAZADA_VN','VN_LAZADA');
          if(!C.MARKETS[market]){message('이 상품의 판매 시장을 확인할 수 없습니다.',true);return;}
          $('offer-market').value=market;$('offer-sale_price').value=product.price;syncFxInput();$('offer-sale_url').value=product.url;$('offer-confirmed').checked=false;$('offer-group').value='';$('offer-form').scrollIntoView({behavior:'smooth',block:'center'});$('offer-group').focus();message('현지 판매가를 넣었습니다. 환율 출처와 동일상품 그룹·수수료·배송비를 확인하세요.');
        }
      };action.append(button);$('collected-results').append(tr);
    }
    $('collected-table').hidden=products.length===0;
    $('collector-message').textContent=(data.message||'')+' 조회 결과 '+products.length+'개. 가격은 동일 통화 안에서 낮은 순이며, 동일상품 여부와 배송료는 별도 확인이 필요합니다.';
  }
  $('search').addEventListener('click',guard(async()=>{
    const links=C.searchLinks($('keyword').value);$('search-links').replaceChildren();
    for(const [name,url] of Object.entries(links)){const link=text('a',name+' ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';$('search-links').append(link);}
    if(!backend){message('이 주소에는 자동 수집 서버가 연결되어 있지 않습니다. 검색 링크만 사용할 수 있습니다.',true);return;}
    const selected=[...$('source-picker').querySelectorAll('input:checked')].map(input=>input.value);if(!selected.length)throw new Error('검색할 쇼핑몰을 하나 이상 선택하세요.');
    $('search').disabled=true;$('collector-message').textContent='공개 상품 가격을 조회하고 있습니다…';$('collected-results').replaceChildren();$('source-status').replaceChildren();$('collected-table').hidden=true;
    try{
      const params=new URLSearchParams({q:$('keyword').value,sources:selected.join(',')});const response=await fetch('api/collect?'+params,{headers:{Accept:'application/json'}});const data=await response.json();if(!response.ok)throw new Error(data.error||'자동 수집 요청에 실패했습니다.');showCollected(data);
      message(data.products?.length?'실제 조회한 가격을 표시했습니다. 출처·옵션·배송료를 확인하세요.':(data.message||'가격을 가져오지 못했습니다. 출처별 상태를 확인하세요.'),!data.products?.length);
    }catch(error){$('collector-message').textContent='조회에 실패했습니다. '+error.message;throw error;}finally{$('search').disabled=false;}
  }));
  $('keyword').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('search').click();}});
  $('csv-file').addEventListener('change',guard(async()=>{
    const file=$('csv-file').files[0];if(!file)return;try{if(file.size>2*1024*1024)throw new Error('CSV는 2MB 이하로 업로드하세요.');const decoded=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());const rows=C.parseCsv(decoded);state.rows=cleanRows([...state.rows,...rows],readSettings());refresh();message(rows.length+'개 후보를 가져왔습니다.');}catch(error){if(error instanceof TypeError)throw new Error('UTF-8로 저장한 CSV 파일을 사용하세요.');throw error;}finally{$('csv-file').value='';}
  }));
  $('csv-sample').addEventListener('click',()=>download('sourcing-template.csv',new Blob(['\ufefftitle,price,source,shipping,group,url\r\n'],{type:'text/csv;charset=utf-8'})));
  $('metric').addEventListener('change',guard(refresh));
  $('product-export').addEventListener('click',guard(()=>{refresh();if(!state.rows.length)throw new Error('사입 후보를 먼저 추가하세요.');X.downloadWorkbook('sourcing-profit.xlsx',[{name:'사입 분석',rows:tableRows(current.analysis.rows,productFields)},{name:'비용 설정',rows:settingsRows()}]);message('사입 분석 엑셀을 저장했습니다.');}));
  $('comparison-export').addEventListener('click',guard(()=>{
    refresh();if(!current.comparison.rows.length)throw new Error('사입 후보와 판매 시나리오를 먼저 추가하세요.');if(current.comparison.rows.length>10000)throw new Error('엑셀은 10,000개 조합까지 저장합니다. 후보나 판매 시나리오를 줄여주세요.');
    const offers=[['동일상품 그룹','판매 시장','현지 판매가','환율 KRW/현지통화','수수료 %','세금 충당 %','국제·고객 발송비 KRW','관세·기타비 KRW','반품 충당 %','사용자 확인','시세 링크','환율 출처','네이버 조회시각 UTC','고시 단위 표시값','고시 통화 단위','환율 원본','계산 포함'],...state.offers.map(offer=>{const p=rateProvenance(offer);return [offer.group,offer.market,...['sale_price','exchange_rate','fee_pct','tax_pct','outbound_shipping','other_cost','refund_pct'].map(key=>Number(offer[key])),offer.confirmed,offer.sale_url,p.fx_source,p.fx_observed_at,p.fx_quoted_rate,p.fx_quoted_units,p.fx_source_url,state.demo||offer.fx_mode!=='naver'||!!quoteFor(C.MARKETS[offer.market].currency)];})];
    const rates=F.normalizeResponse(latestFx).rates;
    const fxRows=[['통화','1단위당 KRW','고시 표시값','고시 통화 단위','조회시각 UTC','출처','환율 구분','원본 링크'],...Object.values(rates).map(rate=>[rate.currency,rate.krw_per_unit,rate.quoted_rate,rate.quoted_units,rate.observed_at,rate.source,rate.rate_type,rate.source_url]),['설명','조회한 참고 환율이며 각 상품에 실제 적용한 환율은 비교표와 판매 시나리오에서 확인합니다.'],['미조회 통화',Object.keys(F.normalizeResponse(latestFx).errors).join(', ')]];
    X.downloadWorkbook('PH-VN-comparison.xlsx',[{name:'추천 TOP3',rows:tableRows(current.comparison.top,comparisonFields)},{name:'국가 플랫폼 비교',rows:tableRows(current.comparison.rows,comparisonFields)},{name:'판매 시나리오',rows:offers},{name:'계산 가정',rows:settingsRows()},{name:'네이버 환율 조회',rows:fxRows}]);message('추천·플랫폼 비교와 적용 환율 출처를 엑셀로 저장했습니다.');
  }));
  $('backup').addEventListener('click',guard(()=>{refresh();download('sourcing-backup.json',new Blob([JSON.stringify(state,null,2)],{type:'application/json;charset=utf-8'}));message('작업 백업을 저장했습니다.');}));
  $('restore-file').addEventListener('change',guard(async()=>{
    const file=$('restore-file').files[0];if(!file)return;try{if(file.size>2*1024*1024)throw new Error('백업 파일은 2MB 이하만 가능합니다.');const saved=JSON.parse(await file.text());restore(saved);refresh();message('백업을 불러왔습니다.');}finally{$('restore-file').value='';}
  }));
  function restore(saved){
    if(!saved||saved.version!==1||!Array.isArray(saved.rows)||!Array.isArray(saved.offers)||!saved.settings)throw new Error('MK커뮤니케이션 백업 파일 형식을 확인하세요.');
    C.compare(saved);const normalized=cleanRows(saved.rows,saved.settings);
    state={version:1,rows:normalized,offers:saved.offers,settings:C.analyze(saved).settings,metric:saved.metric||'profit',demo:saved.demo===true};
    for(const key of Object.keys(labels))$('common-'+key).value=state.settings[key];$('metric').value=state.metric;
  }
  $('clear').addEventListener('click',guard(()=>{
    if((state.rows.length||state.offers.length)&&!confirm('상품·판매 시나리오·비용 설정을 모두 지울까요? 백업이 없으면 복구할 수 없습니다.'))return;
    state={version:1,rows:[],offers:[],settings:{...C.DEFAULTS},metric:'profit',demo:false};for(const key of Object.keys(labels))$('common-'+key).value=C.DEFAULTS[key];$('metric').value='profit';$('fx-mode').value='naver';syncFxInput();refresh();message('작업 내용을 모두 지웠습니다.');
  }));
  $('demo').addEventListener('click',guard(()=>{
    if((state.rows.length||state.offers.length)&&!confirm('현재 작업 내용을 예시로 바꿀까요? 필요한 내용은 먼저 백업하세요.'))return;
    const row=(title,price,source,group)=>({title:'예시 '+title,price,source:'예시 '+source,group,shipping:0,url:''});
    const offer=(group,market,price,rate)=>({group,market,sale_price:price,exchange_rate:rate,fee_pct:12,tax_pct:3,outbound_shipping:4000,other_cost:0,refund_pct:2,confirmed:true,sale_url:''});
    restore({version:1,demo:true,rows:[row('선크림 50ml',7000,'국내몰 A','DEMO-SUN'),row('선크림 50ml',8000,'국내몰 B','DEMO-SUN'),row('수납 파우치',2500,'국내몰 C','DEMO-POUCH'),row('헤어 브러시',4000,'국내몰 D','DEMO-BRUSH')],offers:[offer('DEMO-SUN','PH_SHOPEE',850,24),offer('DEMO-SUN','PH_LAZADA',900,24),offer('DEMO-POUCH','VN_SHOPEE',250000,.055),offer('DEMO-BRUSH','VN_LAZADA',320000,.055)],settings:{...C.DEFAULTS,min_roi:10},metric:'profit'});
    refresh();message('기능 설명용 예시를 불러왔습니다. 실제 상품 가격이나 현행 수수료가 아닙니다.');
  }));
  try {const saved=localStorage.getItem(storageKey);if(saved){restore(JSON.parse(saved));message('이 브라우저에 저장한 작업을 불러왔습니다.');}}catch(_){message('이전 저장 내용을 읽지 못했습니다. 백업 파일이 있으면 불러와 주세요.',true);}
  try{refresh();$('startup').hidden=true;}catch(error){$('startup').textContent='초기화하지 못했습니다. '+error.message;}
  guard(refreshFx)();
  setInterval(()=>{if(document.visibilityState==='visible')guard(refreshFx)();},10*60*1000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&Date.now()-lastFxAttempt>=10*60*1000)guard(refreshFx)();});
  if(storageAvailable)$('storage-note').textContent='현재 브라우저에 작업 내용을 저장합니다. 공유 PC에서는 사용 후 지워주세요.';
})();
