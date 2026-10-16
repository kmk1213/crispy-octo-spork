(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const C = window.SourcingCore;
  const X = window.SourcingXlsx;
  if (!C || !X) { $('startup').textContent = '기능 파일을 불러오지 못했습니다. 새로고침해 주세요.'; return; }
  const storageKey = 'sourcing-radar-web-v1';
  const labels = {sale_price:'사입 분석표의 원화 판매가', fee_pct:'사입 분석표의 수수료 (%)', tax_pct:'사입 분석표의 세금 충당 (%)', purchase_shipping:'추가 사입 배송료 (원)', outbound_shipping:'사입 분석표 발송비 (원)', packaging:'공통 포장비 (원)', other_cost:'사입 분석표 기타비 (원)', refund_pct:'사입 분석표 반품 충당 (%)', min_roi:'추천 목표 수익률 (%)'};
  const productKeys = ['title', 'source', 'price', 'shipping', 'group', 'url'];
  const offerKeys = ['group','market','sale_price','exchange_rate','fee_pct','tax_pct','outbound_shipping','other_cost','refund_pct','sale_url'];
  let state = {version:1, rows:[], offers:[], settings:{...C.DEFAULTS}, metric:'profit', demo:false};
  let current = null;
  let storageAvailable = true;
  const money = n => n == null ? '—' : Math.round(n).toLocaleString('ko-KR') + '원';
  const percent = n => n == null ? '—' : n.toFixed(1) + '%';
  const text = (tag, value, className) => { const el=document.createElement(tag); el.textContent=value; if(className)el.className=className; return el; };
  function message(value, error=false) { $('message').textContent=value; $('message').classList.toggle('error',error); }
  function guard(callback) { return async event => { try { await callback(event); } catch (error) { message(error.message || '처리하지 못했습니다. 입력 내용을 확인하세요.',true); } }; }
  function readSettings() { return {...Object.fromEntries(Object.keys(labels).map(key=>[key,$('common-'+key).value])),exchange_rate:1}; }
  function payload() { return {rows:state.rows,offers:state.offers,settings:readSettings(),metric:$('metric').value}; }
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
      info.append(text('small',Number(offer.sale_price).toLocaleString('ko-KR')+' '+market.currency+' / '+(offer.confirmed?'시세 사용자 확인':'시세 미확인')));
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
      [product.recommendation_rank?product.recommendation_rank+'위':'—',product.title+' / '+product.group,product.source,product.country+' '+product.platform,Number(product.sale_price).toLocaleString('ko-KR')+' '+product.currency,money(product.total_cost),money(product.profit),percent(product.roi_pct),product.confirmed?'사용자 확인':'미확인'].forEach((value,index)=>newCell(tr,value,index===6?(product.profit>=0?'positive':'negative'):''));
      $('comparison-results').append(tr);
    }
    $('recommendations-empty').hidden=data.top.length>0;
    if(data.rows.length&&!data.top.length)$('recommendations-empty').replaceChildren(text('strong','추천 조건을 충족하는 상품이 없습니다'),text('p','시세 확인 여부, 순이익과 목표 수익률을 확인하세요.'));
    else if(!data.rows.length)$('recommendations-empty').replaceChildren(text('strong','수익을 비교할 준비가 되셨나요?'),text('p','사입 후보와 판매 시나리오를 추가하면 조건에 맞는 상품을 추천합니다.'));
    $('compare-note').textContent=(data.unmatched_groups.length?'사입 후보가 없는 그룹: '+data.unmatched_groups.join(', ')+'. ':'')+(data.rows.length>300?'비교표는 앞의 300개 조합을 표시합니다. 엑셀에는 모든 조합을 저장합니다.':'');
    $('stat-profit').textContent=data.rows.length?money(data.rows.reduce((best,row)=>Math.max(best,row.profit),-Infinity)):'—';
  }
  function refresh() {
    const input=payload();const analysis=C.analyze(input);const comparison=C.compare(input);
    current={analysis,comparison};state.settings=analysis.settings;state.metric=input.metric;
    showProducts(analysis);showOffers();showComparison(comparison);$('demo-banner').hidden=!state.demo;persist();
  }
  function download(filename, blob) {const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function settingsRows() {
    return [['항목','값'],...Object.entries(readSettings()),['추천 기준',$('metric').value],['데모 여부',state.demo],['계산 기준','매출=판매가×환율. 수익률=순이익÷(사입 합계+발송비+포장비+기타비)×100.'],['세금','매출 비례 충당 추정. 실제 부가세·소득세·관세 정산이 아닙니다.'],['시세','사용자 입력 시세. 실시간 가격·수요·판매량은 검증하지 않았습니다.']];
  }
  function tableRows(rows, fields){return [fields.map(([,label])=>label),...rows.map(row=>fields.map(([key])=>row[key]??null))];}
  const productFields=[['rank','그룹 내 가격순'],['group','동일상품 그룹'],['title','상품'],['source','사입처'],['price','사입가 KRW'],['shipping','판매처 배송료'],['purchase_total','사입 합계 KRW'],['revenue','매출 KRW'],['fee','수수료'],['tax','세금 충당'],['refund_reserve','반품 충당'],['total_cost','전체비용'],['profit','순이익'],['roi_pct','수익률 %'],['margin_pct','마진율 %'],['break_even','손익분기 매출 KRW'],['url','사입 링크']];
  const comparisonFields=[['recommendation_rank','추천 상품 순위'],['group','동일상품 그룹'],['title','상품'],['source','사입처'],['purchase_total','사입 합계 KRW'],['country','판매 국가'],['platform','판매 플랫폼'],['currency','현지 통화'],['sale_price','현지 판매가'],['exchange_rate','환율 KRW/현지통화'],['revenue','매출 KRW'],['fee','수수료 KRW'],['tax','세금 충당 KRW'],['refund_reserve','반품 충당 KRW'],['total_cost','전체비용 KRW'],['profit','순이익 KRW'],['roi_pct','수익률 %'],['margin_pct','마진율 %'],['confirmed','시세 사용자 확인'],['url','사입 링크'],['sale_url','판매 시세 링크']];

  // Build common inputs before restoring saved work.
  for(const [key,label] of Object.entries(labels)){
    const wrapper=text('label',label);const input=document.createElement('input');Object.assign(input,{id:'common-'+key,type:'number',min:'0',step:'any',value:C.DEFAULTS[key]});if(['fee_pct','tax_pct','refund_pct'].includes(key))input.max='100';wrapper.append(input);$('common-fields').append(wrapper);
    input.addEventListener('change',guard(()=>{try{refresh();message('비용 설정을 반영했습니다.');}catch(error){current=null;$('top3').replaceChildren();$('comparison-results').replaceChildren();$('stat-profit').textContent='—';throw error;}}));
  }
  for(const [key,market] of Object.entries(C.MARKETS)){const option=text('option',market.country+' / '+market.platform+' ('+market.currency+')');option.value=key;$('offer-market').append(option);}
  $('offer-market').addEventListener('change',()=>{$('currency-label').textContent=C.MARKETS[$('offer-market').value].currency;});
  $('product-form').addEventListener('submit',guard(event=>{
    event.preventDefault();const row=Object.fromEntries(productKeys.map(key=>[key,$('product-'+key).value]));row.group=row.group.trim();
    state.rows=cleanRows([...state.rows,row],readSettings());refresh();message('사입 후보를 추가했습니다.');$('product-title').value='';$('product-price').value='';
  }));
  $('offer-form').addEventListener('submit',guard(event=>{
    event.preventDefault();const offer=Object.fromEntries(offerKeys.map(key=>[key,$('offer-'+key).value]));offer.group=offer.group.trim();offer.confirmed=$('offer-confirmed').checked;
    if(!state.rows.some(row=>row.group===offer.group))throw new Error('같은 그룹의 사입 후보를 먼저 추가하세요.');
    C.compare({...payload(),offers:[...state.offers,offer]});state.offers.push(offer);refresh();message('판매 시나리오와 추천 결과를 반영했습니다.');$('offer-confirmed').checked=false;
  }));
  $('search').addEventListener('click',guard(()=>{
    const links=C.searchLinks($('keyword').value);$('search-links').replaceChildren();
    for(const [name,url] of Object.entries(links)){const link=text('a',name+' ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';$('search-links').append(link);}
    message('쇼핑몰 검색 링크를 열어 동일상품의 시세를 확인하세요. 가격 자동 수집은 아직 연결되지 않았습니다.');
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
    const offers=[['동일상품 그룹','판매 시장','현지 판매가','환율 KRW/현지통화','수수료 %','세금 충당 %','국제·고객 발송비 KRW','관세·기타비 KRW','반품 충당 %','사용자 확인','시세 링크'],...state.offers.map(offer=>[offer.group,offer.market,...['sale_price','exchange_rate','fee_pct','tax_pct','outbound_shipping','other_cost','refund_pct'].map(key=>Number(offer[key])),offer.confirmed,offer.sale_url])];
    X.downloadWorkbook('PH-VN-comparison.xlsx',[{name:'추천 TOP3',rows:tableRows(current.comparison.top,comparisonFields)},{name:'국가 플랫폼 비교',rows:tableRows(current.comparison.rows,comparisonFields)},{name:'판매 시나리오',rows:offers},{name:'계산 가정',rows:settingsRows()}]);message('추천 TOP3와 전체 플랫폼 비교 엑셀을 저장했습니다.');
  }));
  $('backup').addEventListener('click',guard(()=>{refresh();download('sourcing-backup.json',new Blob([JSON.stringify(state,null,2)],{type:'application/json;charset=utf-8'}));message('작업 백업을 저장했습니다.');}));
  $('restore-file').addEventListener('change',guard(async()=>{
    const file=$('restore-file').files[0];if(!file)return;try{if(file.size>2*1024*1024)throw new Error('백업 파일은 2MB 이하만 가능합니다.');const saved=JSON.parse(await file.text());restore(saved);refresh();message('백업을 불러왔습니다.');}finally{$('restore-file').value='';}
  }));
  function restore(saved){
    if(!saved||saved.version!==1||!Array.isArray(saved.rows)||!Array.isArray(saved.offers)||!saved.settings)throw new Error('사입 레이더 백업 파일 형식을 확인하세요.');
    C.compare(saved);const normalized=cleanRows(saved.rows,saved.settings);
    state={version:1,rows:normalized,offers:saved.offers,settings:C.analyze(saved).settings,metric:saved.metric||'profit',demo:saved.demo===true};
    for(const key of Object.keys(labels))$('common-'+key).value=state.settings[key];$('metric').value=state.metric;
  }
  $('clear').addEventListener('click',guard(()=>{
    if((state.rows.length||state.offers.length)&&!confirm('상품·판매 시나리오·비용 설정을 모두 지울까요? 백업이 없으면 복구할 수 없습니다.'))return;
    state={version:1,rows:[],offers:[],settings:{...C.DEFAULTS},metric:'profit',demo:false};for(const key of Object.keys(labels))$('common-'+key).value=C.DEFAULTS[key];$('metric').value='profit';refresh();message('작업 내용을 모두 지웠습니다.');
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
  if(storageAvailable)$('storage-note').textContent='현재 브라우저에 작업 내용을 저장합니다. 공유 PC에서는 사용 후 지워주세요.';
})();
