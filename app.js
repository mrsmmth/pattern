const DB_NAME='pattern-midi-library';
const STORE='patterns';
let patterns=[];
let sortMode='recent';
let audioCtx=null;
let activeStop=null;

const $=s=>document.querySelector(s);
const grid=$('#patternGrid'), empty=$('#emptyState'), count=$('#patternCount'), toast=$('#toast');

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'});
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function dbAll(){const db=await openDB();return new Promise((res,rej)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function dbPut(v){const db=await openDB();return new Promise((res,rej)=>{const r=db.transaction(STORE,'readwrite').objectStore(STORE).put(v);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}

function readVar(bytes,state){let value=0,b;do{b=bytes[state.i++];value=(value<<7)|(b&0x7f)}while(b&0x80);return value}
function u16(v,o){return (v[o]<<8)|v[o+1]}
function u32(v,o){return ((v[o]<<24)>>>0)+(v[o+1]<<16)+(v[o+2]<<8)+v[o+3]}
function str(v,o,n){return String.fromCharCode(...v.slice(o,o+n))}

function parseMidi(buffer){
  const v=new Uint8Array(buffer); if(str(v,0,4)!=='MThd') throw new Error('MIDIファイルではありません');
  const tracks=u16(v,10), division=u16(v,12); if(division&0x8000) throw new Error('SMPTE MIDIは未対応です');
  let off=8+u32(v,4), notes=[], tempos=[{tick:0,us:500000}], maxTick=0;
  for(let t=0;t<tracks;t++){
    if(str(v,off,4)!=='MTrk') break; const len=u32(v,off+4), end=off+8+len; let s={i:off+8},tick=0,status=0,open=new Map();
    while(s.i<end){
      tick+=readVar(v,s); let b=v[s.i++]; if(b<0x80){s.i--;b=status}else status=b;
      if(b===0xff){const type=v[s.i++],l=readVar(v,s);if(type===0x51&&l===3)tempos.push({tick,us:(v[s.i]<<16)|(v[s.i+1]<<8)|v[s.i+2]});s.i+=l;continue}
      if(b===0xf0||b===0xf7){s.i+=readVar(v,s);continue}
      const cmd=b&0xf0,ch=b&0x0f,need=(cmd===0xc0||cmd===0xd0)?1:2,d1=v[s.i++],d2=need===2?v[s.i++]:0;
      const key=ch+':'+d1;
      if(cmd===0x90&&d2>0){if(!open.has(key))open.set(key,[]);open.get(key).push({tick,pitch:d1,velocity:d2,ch})}
      if(cmd===0x80||(cmd===0x90&&d2===0)){const q=open.get(key);if(q&&q.length){const n=q.shift();notes.push({...n,end:Math.max(tick,n.tick+1)})}}
      maxTick=Math.max(maxTick,tick);
    } off=end;
  }
  notes.sort((a,b)=>a.tick-b.tick||a.pitch-b.pitch);tempos.sort((a,b)=>a.tick-b.tick);
  return {division,notes,tempos,maxTick};
}

function tickToSeconds(tick,m){let last=0,sec=0,us=500000;for(const t of m.tempos){if(t.tick>=tick)break;sec+=(t.tick-last)/m.division*us/1e6;last=t.tick;us=t.us}return sec+(tick-last)/m.division*us/1e6}

function drawRoll(canvas,m){
  const dpr=Math.min(devicePixelRatio||1,2),rect=canvas.getBoundingClientRect();canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  const c=canvas.getContext('2d');c.scale(dpr,dpr);const w=rect.width,h=rect.height;
  c.fillStyle='#262824';c.fillRect(0,0,w,h);
  for(let i=1;i<4;i++){c.strokeStyle='rgba(230,224,210,.10)';c.lineWidth=1;c.beginPath();c.moveTo(w*i/4,0);c.lineTo(w*i/4,h);c.stroke()}
  const first=m.notes.length?Math.min(...m.notes.map(n=>n.tick)):0,four=m.division*4,end=first+four, visible=m.notes.filter(n=>n.end>first&&n.tick<end); if(!visible.length)return;
  let lo=Math.min(...visible.map(n=>n.pitch)),hi=Math.max(...visible.map(n=>n.pitch));lo-=2;hi+=2;const range=Math.max(hi-lo,9);
  const lowPitch=Math.min(...visible.map(x=>x.pitch));
  for(const n of visible){const x=(Math.max(n.tick,first)-first)/four*w,y=h-18-(n.pitch-lo)/range*(h-38),nw=Math.max(4,(Math.min(n.end,end)-Math.max(n.tick,first))/four*w);c.fillStyle=n.pitch===lowPitch?'#c89454':'#d8d1c3';c.beginPath();roundRect(c,x+2,y-3,nw-3,7,3);c.fill()}
}
function roundRect(c,x,y,w,h,r){w=Math.max(w,1);c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r)}

async function addFiles(files){
  let added=0;
  for(const file of files){
    if(!/\.(mid|midi)$/i.test(file.name))continue;
    try{const buf=await file.arrayBuffer(),m=parseMidi(buf);if(!m.notes.length)throw new Error('ノートがありません');const id=crypto.randomUUID();const p={id,fileName:file.name,bytes:Array.from(new Uint8Array(buf)),favorite:false,uses:0,created:Date.now(),lastUsed:0};await dbPut(p);patterns.push(p);added++}catch(e){showToast(`${file.name}: ${e.message}`)}
  }
  if(added){showToast(`${added} PATTERN${added>1?'S':''} ADDED`);render()}
}

function midiOf(p){return parseMidi(new Uint8Array(p.bytes).buffer)}
function sorted(){return [...patterns].sort((a,b)=>sortMode==='used'?(b.uses-a.uses||b.lastUsed-a.lastUsed):sortMode==='favorite'?((b.favorite?1:0)-(a.favorite?1:0)||b.lastUsed-a.lastUsed):(b.created-a.created))}

function render(){
  grid.innerHTML='';count.textContent=`${patterns.length} PATTERN${patterns.length===1?'':'S'}`;empty.hidden=patterns.length>0;
  sorted().forEach((p,index)=>{
    const el=$('#cardTemplate').content.firstElementChild.cloneNode(true),m=midiOf(p);
    el.dataset.id=p.id;el.querySelector('.pattern-no').textContent=`P-${String(patterns.length-index).padStart(3,'0')}`;
    const fav=el.querySelector('.favorite-btn');fav.textContent=p.favorite?'★':'☆';fav.classList.toggle('on',p.favorite);
    el.querySelector('.uses').textContent=`${p.uses} USE${p.uses===1?'':'S'}`;
    const canvas=el.querySelector('canvas'),visual=el.querySelector('.visual-button');visual.draggable=true;grid.appendChild(el);requestAnimationFrame(()=>drawRoll(canvas,m));
    fav.onclick=async()=>{p.favorite=!p.favorite;await dbPut(p);render()};
    visual.onclick=()=>preview(p,el,m);
    visual.addEventListener('dragstart',e=>dragMidi(e,p));
    const drag=el.querySelector('.drag-handle');drag.addEventListener('dragstart',e=>dragMidi(e,p));
    drag.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')downloadMidi(p)});
    el.querySelector('.export-action').onclick=()=>downloadMidi(p);
  });
}

function preview(p,card,m){
  if(activeStop){activeStop();activeStop=null;document.querySelectorAll('.playing').forEach(x=>x.classList.remove('playing'))}
  audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();const start=audioCtx.currentTime+.04,first=m.notes.length?Math.min(...m.notes.map(n=>n.tick)):0,four=m.division*4,endTick=first+four,baseSec=tickToSeconds(first,m),shown=m.notes.filter(n=>n.end>first&&n.tick<endTick);
  const duration=Math.max(.2,tickToSeconds(endTick,m)-baseSec); card.style.setProperty('--duration',duration+'s');card.classList.add('playing');
  const nodes=[]; for(const n of shown){const st=start+Math.max(0,tickToSeconds(Math.max(n.tick,first),m)-baseSec),en=start+Math.min(duration,tickToSeconds(Math.min(n.end,endTick),m)-baseSec);const o=audioCtx.createOscillator(),g=audioCtx.createGain(),lp=audioCtx.createBiquadFilter();o.type='triangle';o.frequency.value=440*Math.pow(2,(n.pitch-69)/12);lp.type='lowpass';lp.frequency.value=2200;g.gain.setValueAtTime(0.0001,st);g.gain.exponentialRampToValueAtTime(Math.max(.012,n.velocity/127*.065),st+.008);g.gain.exponentialRampToValueAtTime(.0001,Math.max(st+.03,en));o.connect(lp).connect(g).connect(audioCtx.destination);o.start(st);o.stop(Math.max(st+.04,en+.02));nodes.push(o)}
  const timer=setTimeout(()=>{card.classList.remove('playing');activeStop=null},duration*1000+100);activeStop=()=>{clearTimeout(timer);nodes.forEach(n=>{try{n.stop()}catch{}})};
}

async function countUse(p){p.uses++;p.lastUsed=Date.now();await dbPut(p)}
function blobOf(p){return new Blob([new Uint8Array(p.bytes)],{type:'audio/midi'})}
function dragMidi(e,p){
  const url=URL.createObjectURL(blobOf(p));
  e.dataTransfer.effectAllowed='copy';
  e.dataTransfer.setData('DownloadURL',`audio/midi:${p.fileName||'pattern.mid'}:${url}`);
  e.dataTransfer.setData('text/uri-list',url);
  setTimeout(()=>URL.revokeObjectURL(url),30000);
  countUse(p);
}
async function downloadMidi(p){const a=document.createElement('a');a.href=URL.createObjectURL(blobOf(p));a.download=p.fileName||'pattern.mid';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);await countUse(p);showToast('MIDI READY');render()}
function showToast(msg){toast.textContent=msg;toast.classList.add('show');clearTimeout(showToast.t);showToast.t=setTimeout(()=>toast.classList.remove('show'),1800)}

$('#midiInput').addEventListener('change',e=>{addFiles([...e.target.files]);e.target.value=''})
const dz=$('#dropzone');['dragenter','dragover'].forEach(x=>dz.addEventListener(x,e=>{e.preventDefault();dz.classList.add('dragover')}));['dragleave','drop'].forEach(x=>dz.addEventListener(x,e=>{e.preventDefault();dz.classList.remove('dragover')}));dz.addEventListener('drop',e=>addFiles([...e.dataTransfer.files]));
$('#sortTabs').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;sortMode=b.dataset.sort;document.querySelectorAll('#sortTabs button').forEach(x=>x.classList.toggle('active',x===b));render()});
window.addEventListener('resize',()=>document.querySelectorAll('.card').forEach(card=>{const p=patterns.find(x=>x.id===card.dataset.id);if(p)drawRoll(card.querySelector('canvas'),midiOf(p))}));

(async()=>{patterns=await dbAll();render();if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{})})();
