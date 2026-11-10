// スプレッドシートの予定から calendar.ics（Googleカレンダー等で購読できる形式）を作り、
// 公開用フォルダ（既定: _site）にサイト一式と一緒に書き出します。
// GitHub Actions（.github/workflows/build.yml）から定期的に実行されます。
//
//   node scripts/build-ics.mjs [出力フォルダ]
//
// スプレッドシートのURL・シート名・タイトルは index.html の CONFIG から読み取ります。
// （環境変数 SHEET_URL / CSV_FILE で上書き可。CSV_FILE はテスト用のローカルCSV）

import { readFile, writeFile, mkdir, cp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const OUT = process.argv[2] || '_site';
const html = await readFile('index.html', 'utf8');
const cfg = k => (html.match(new RegExp(`\\b${k}:\\s*'([^']*)'`)) || [])[1] || '';
const SHEET_URL  = process.env.SHEET_URL || cfg('SHEET_URL');
const SHEET_NAME = cfg('SHEET_NAME');
const TITLE      = cfg('TITLE') || 'カレンダー';
const DEFAULT_MIN = 120;   // 終了時刻が無い予定の長さ（分）
const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
const SITE_URL = process.env.SITE_URL || (owner && repo ? `https://${owner.toLowerCase()}.github.io/${repo}/` : '');

/* ---------- 読み込み ---------- */
function csvUrls(input, sheetName){
  const gid = (input.match(/[#&?]gid=(\d+)/) || [])[1];
  const pub = input.match(/\/spreadsheets\/d\/e\/([\w-]+)/);
  if(pub) return [`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid ? `&gid=${gid}` : ''}`];
  const id = (input.match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1];
  if(!id) throw new Error('SHEET_URL からスプレッドシートIDを読み取れません');
  const gviz = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1` +
               (sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : gid ? `&gid=${gid}` : '');
  // export は表示どおりの値をそのまま出すので型の自動判定で値が消えない → 優先
  return sheetName ? [gviz] : [`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid || 0}`, gviz];
}

async function loadCsv(){
  if(process.env.CSV_FILE) return readFile(process.env.CSV_FILE, 'utf8');
  if(!SHEET_URL) throw new Error('index.html の CONFIG.SHEET_URL が空です');
  let last;
  for(const u of csvUrls(SHEET_URL, SHEET_NAME)){
    try{
      const res = await fetch(u, { redirect: 'follow' });
      const text = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      if(/^\s*<(!doctype|html)/i.test(text)) throw new Error('HTMLが返りました（共有設定を確認）');
      console.log(`読み込み: ${u}`);
      return text;
    }catch(e){ last = e; console.warn(`失敗: ${u} — ${e.message}`); }
  }
  throw last;
}

/* ---------- 解析（index.html と同じルール） ---------- */
const FIELDS = {
  date:['日付','開始日','日にち','年月日','date','startdate','start'], endDate:['終了日','enddate','end'],
  startTime:['開始時刻','開始時間','時刻','時間','starttime','time'], endTime:['終了時刻','終了時間','endtime'],
  title:['タイトル','予定','予定名','イベント','イベント名','件名','内容','title','event','summary','name'],
  category:['カテゴリ','カテゴリー','種類','種別','分類','タグ','category','type','tag'],
  place:['場所','会場','location','place','venue'], desc:['説明','詳細','メモ','備考','description','memo','note','notes','details'],
  url:['url','リンク','link'], color:['色','カラー','color','colour'],
  image:['画像','画像url','画像リンク','イメージ','写真','サムネイル','サムネ','image','img','imageurl','picture','photo','thumbnail'],
};
function parseCSV(text){
  const rows=[]; let row=[], f='', q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){ f+='"'; i++; } else q=false; } else f+=c; }
    else if(c==='"') q=true;
    else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; }
    else if(c!=='\r') f+=c;
  }
  if(f!=='' || row.length){ row.push(f); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}
// 年なしの日付（11/2 など）は今日に一番近い年として扱う
function nearestYear(m, d){
  const now = jstToday();
  const cands = [-1,0,1].map(k => ({y: now.y + k}));
  let best = now.y, bestDiff = Infinity;
  for(const {y} of cands){
    const diff = Math.abs(Date.UTC(y, m-1, d) - Date.UTC(now.y, now.m-1, now.d));
    if(diff < bestDiff){ bestDiff = diff; best = y; }
  }
  return best;
}
function jstToday(){ const t = new Date(Date.now() + 9*3600e3); return {y:t.getUTCFullYear(), m:t.getUTCMonth()+1, d:t.getUTCDate()}; }
function parseDate(s){
  s = String(s||'').trim().replace(/[（(][^)）]*[)）]/g,'');
  if(!s) return null;
  let m = s.match(/(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  if(m) return {y:+m[1], m:+m[2], d:+m[3]};
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(m) return {y:+m[3], m:+m[1], d:+m[2]};
  m = s.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if(m) return {y:nearestYear(+m[1], +m[2]), m:+m[1], d:+m[2]};
  return null;
}
function parseTime(s){
  s = String(s||'').trim();
  const m = s.match(/(\d{1,2})[:：時](\d{2})?/);
  if(!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0);
  if(/(PM|午後)/i.test(s) && h < 12) h += 12;
  if(/(AM|午前)/i.test(s) && h === 12) h = 0;
  return {h, mi};
}
function rowsToEvents(rows){
  const norm = s => String(s).toLowerCase().replace(/[\s_\-・]/g,'');
  const head = rows[0].map(norm), idx = {};
  for(const [k,names] of Object.entries(FIELDS)){
    const i = head.findIndex(h => names.map(norm).includes(h));
    if(i >= 0) idx[k] = i;
  }
  let body = rows.slice(1);
  if(idx.date === undefined){ idx.date = 0; idx.title = 1; body = rows; }
  if(idx.title === undefined) idx.title = idx.date === 0 ? 1 : 0;
  const get = (r,k) => idx[k] === undefined ? '' : (r[idx[k]] ?? '').trim();
  const out = [];
  for(const r of body){
    const raw = get(r,'date'), start = parseDate(raw), title = get(r,'title');
    if(!start || !title) continue;               // 画像だけの行（背景用）は購読カレンダーには出さない
    let end = parseDate(get(r,'endDate')) || start;
    if(Date.UTC(end.y,end.m-1,end.d) < Date.UTC(start.y,start.m-1,start.d)) end = start;
    let st = parseTime(get(r,'startTime'));
    if(!st && /\d{1,2}:\d{2}/.test(raw.replace(/^\S+/,''))) st = parseTime(raw.replace(/^\S+/,''));
    let url = get(r,'url'), image = get(r,'image');
    if(!image && /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(url)){ image = url; url = ''; }
    out.push({ title, start, end, st, et: parseTime(get(r,'endTime')),
      category:get(r,'category'), place:get(r,'place'), desc:get(r,'desc'), url });
  }
  return out;
}

/* ---------- ICS ---------- */
const p2 = n => String(n).padStart(2,'0');
const ymd = ({y,m,d}) => `${y}${p2(m)}${p2(d)}`;
const addDays = ({y,m,d}, n) => { const t = new Date(Date.UTC(y,m-1,d+n)); return {y:t.getUTCFullYear(), m:t.getUTCMonth()+1, d:t.getUTCDate()}; };
const escText = s => String(s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
function fold(line){            // 75オクテットごとに折り返し（UTF-8の文字途中では切らない）
  const out = []; let cur = '', bytes = 0;
  for(const ch of line){
    const b = Buffer.byteLength(ch);
    if(bytes + b > (out.length ? 74 : 75)){ out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function toICS(events){
  const stamp = new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+/,'');
  const L = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//NexuSquid//Sheet Calendar//JA','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(TITLE)}`,'X-WR-TIMEZONE:Asia/Tokyo','REFRESH-INTERVAL;VALUE=DURATION:PT1H','X-PUBLISHED-TTL:PT1H',
    'BEGIN:VTIMEZONE','TZID:Asia/Tokyo','BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0900','TZOFFSETTO:+0900','TZNAME:JST','END:STANDARD','END:VTIMEZONE'];
  const seen = new Map();
  for(const e of events){
    const key = `${ymd(e.start)}|${e.st ? p2(e.st.h)+p2(e.st.mi) : ''}|${e.title}`;
    const n = (seen.get(key) || 0) + 1; seen.set(key, n);
    const uid = createHash('sha1').update(key + '#' + n).digest('hex').slice(0,20) + '@nexusquid-calendar';
    L.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`);
    if(e.st){
      const sMin = e.st.h*60 + e.st.mi;
      let endDate = e.end, eMin;
      if(e.et){ eMin = e.et.h*60 + e.et.mi; if(ymd(e.end) === ymd(e.start) && eMin <= sMin) endDate = addDays(e.start, 1); } // 22:00〜1:00 → 翌日
      else { eMin = sMin + DEFAULT_MIN; if(ymd(e.end) === ymd(e.start) && eMin >= 1440){ endDate = addDays(e.start, 1); eMin -= 1440; } }
      L.push(`DTSTART;TZID=Asia/Tokyo:${ymd(e.start)}T${p2(e.st.h)}${p2(e.st.mi)}00`,
             `DTEND;TZID=Asia/Tokyo:${ymd(endDate)}T${p2(Math.floor(eMin/60)%24)}${p2(eMin%60)}00`);
    }else{
      L.push(`DTSTART;VALUE=DATE:${ymd(e.start)}`, `DTEND;VALUE=DATE:${ymd(addDays(e.end,1))}`);
    }
    L.push(`SUMMARY:${escText(e.title)}`);
    const desc = [e.category && `【${e.category}】`, e.desc, e.url, SITE_URL && `カレンダー: ${SITE_URL}`].filter(Boolean).join('\n');
    if(desc) L.push(`DESCRIPTION:${escText(desc)}`);
    if(e.place) L.push(`LOCATION:${escText(e.place)}`);
    if(e.category) L.push(`CATEGORIES:${escText(e.category)}`);
    if(/^https?:\/\//.test(e.url)) L.push(`URL:${e.url}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

/* ---------- 実行 ---------- */
const events = rowsToEvents(parseCSV(await loadCsv()));
if(!events.length) throw new Error('予定が1件も読み取れませんでした（見出し行・共有設定を確認）');

// サイト一式をコピーして calendar.ics を追加
const SKIP = new Set(['.git','.github','scripts','node_modules',OUT]);
await rm(OUT, { recursive:true, force:true });
await mkdir(OUT, { recursive:true });
for(const name of await readdir('.')){
  if(SKIP.has(name) || name.startsWith('.')) continue;
  await cp(name, path.join(OUT, name), { recursive:true });
}
await writeFile(path.join(OUT,'calendar.ics'), toICS(events));
await writeFile(path.join(OUT,'.nojekyll'), '');
console.log(`calendar.ics: ${events.length}件 → ${OUT}/`);
