/** Crypto Radar TH — Google Apps Script backend v3
 *  วางโค้ดนี้ใน script.google.com แล้ว Deploy เป็นเว็บแอป (เรียกใช้ในฐานะ: ฉัน · สิทธิ์เข้าถึง: ทุกคน)
 *   1) Proxy Binance TH : ?path=/api/v1/klines?symbol=BTCTHB&interval=1h&limit=500
 *   2) ข่าวคริปโต (RSS)  : ?news=1
 *   3) ข่าว + Gemini AI : ?news=1&ai=1   (ต้องตั้งค่า GEMINI_API_KEY)
 *   4) Fear & Greed     : ?fng=1
 *  ตั้งค่า (ไม่บังคับ): ⚙️ การตั้งค่าโปรเจกต์ → คุณสมบัติของสคริปต์
 *   GEMINI_API_KEY  คีย์จาก https://aistudio.google.com/apikey  (เก็บไว้ฝั่งนี้ ไม่หลุดไปอยู่ในหน้าเว็บ)
 *   GEMINI_MODEL    ค่าเริ่มต้น gemini-flash-latest
 *   FEEDS           URL ของ RSS คั่นด้วยเครื่องหมาย ,  (ถ้าไม่ตั้ง ใช้รายการด้านล่าง)
 */
var DEFAULT_FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://cointelegraph.com/rss',
  'https://decrypt.co/feed',
  'https://bitcoinmagazine.com/.rss/full/',
  'https://cryptoslate.com/feed/',
  'https://www.theblock.co/rss.xml',
  'https://siamblockchain.com/feed/'
];

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.news) return out_(getNews_(p.ai === '1'));
    if (p.fng) return out_(getFng_());
    if (p.path) return proxy_(p.path);
    return out_({ ok: true, service: 'Crypto Radar TH', version: 3, ai: !!prop_('GEMINI_API_KEY') });
  } catch (err) {
    return out_({ __error: String((err && err.message) || err) });
  }
}

/* ---------- 1) Proxy Binance TH ---------- */
function proxy_(path) {
  if (!/^\/api\/v1\/(time|ticker\/price|ticker\/24hr|klines|exchangeInfo|depth|trades)(\?|$)/.test(path)) {
    return out_({ __error: 'path not allowed' });
  }
  var cache = CacheService.getScriptCache(), key = 'bn_' + hash_(path), hit = cache.get(key);
  if (hit) return text_(hit);
  var res = UrlFetchApp.fetch('https://api.binance.th' + path, { muteHttpExceptions: true });
  var body = res.getContentText();
  if (res.getResponseCode() === 200 && body.length < 95000) cache.put(key, body, path.indexOf('klines') > -1 ? 15 : 3);
  return text_(body);
}

/* ---------- 2) ข่าวจาก RSS ---------- */
function getNews_(useAi) {
  var cache = CacheService.getScriptCache(), key = 'news3_' + (useAi ? 'ai' : 'raw'), hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var feeds = String(prop_('FEEDS') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  if (!feeds.length) feeds = DEFAULT_FEEDS;
  var reqs = feeds.map(function (u) {
    return { url: u, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (CryptoRadarTH RSS reader)' } };
  });
  var res = UrlFetchApp.fetchAll(reqs), items = [], errors = [], sources = [];
  res.forEach(function (r, i) {
    try {
      if (r.getResponseCode() !== 200) throw new Error('HTTP ' + r.getResponseCode());
      var got = parseFeed_(r.getContentText(), feeds[i]);
      if (!got.length) throw new Error('ไม่พบข่าวในฟีด');
      items = items.concat(got);
      sources.push(host_(feeds[i]));
    } catch (x) { errors.push(host_(feeds[i]) + ': ' + (x.message || x)); }
  });
  var seen = {};
  items = items.filter(function (it) {
    var k = it.title.toLowerCase().slice(0, 80);
    if (!it.title || seen[k]) return false;
    seen[k] = 1; return true;
  });
  items.sort(function (a, b) { return (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0); });
  items = items.slice(0, 100);
  var out = { items: items, sources: sources, errors: errors, fetchedAt: new Date().toISOString(), ai: false };
  if (useAi && prop_('GEMINI_API_KEY')) {
    try { aiScore_(items); out.ai = true; out.model = prop_('GEMINI_MODEL') || 'gemini-flash-latest'; }
    catch (x) { out.aiError = String(x.message || x).slice(0, 300); }
  }
  try { cache.put(key, JSON.stringify(out), useAi ? 900 : 300); } catch (x) { /* ใหญ่เกิน cache ก็ข้ามไป */ }
  return out;
}

function parseFeed_(xml, url) {
  var out = [], src = host_(url);
  try {
    var root = XmlService.parse(xml).getRootElement();
    var atom = XmlService.getNamespace('http://www.w3.org/2005/Atom');
    var dc = XmlService.getNamespace('dc', 'http://purl.org/dc/elements/1.1/');
    var ch = root.getChild('channel');
    if (ch) {
      src = clean_(ch.getChildText('title')) || src;
      ch.getChildren('item').forEach(function (it) {
        out.push(item_(it.getChildText('title'), it.getChildText('link'), it.getChildText('pubDate') || it.getChildText('date', dc), it.getChildText('description'), src));
      });
    } else {
      var t = root.getChild('title', atom);
      if (t) src = clean_(t.getText()) || src;
      root.getChildren('entry', atom).forEach(function (en) {
        var l = en.getChild('link', atom), href = l && l.getAttribute('href') ? l.getAttribute('href').getValue() : '';
        out.push(item_(en.getChildText('title', atom), href, en.getChildText('updated', atom) || en.getChildText('published', atom), en.getChildText('summary', atom), src));
      });
    }
  } catch (e) {
    // ฟีดบางเว็บ XML ไม่สมบูรณ์ → อ่านแบบ regex แทน
    var re = /<item[\s>][\s\S]*?<\/item>/gi, m;
    while ((m = re.exec(xml))) {
      var s = m[0];
      out.push(item_(tag_(s, 'title'), tag_(s, 'link'), tag_(s, 'pubDate') || tag_(s, 'dc:date'), tag_(s, 'description'), src));
    }
  }
  return out.filter(function (x) { return x.title; }).slice(0, 30);
}
function item_(title, link, date, desc, src) {
  var d = Date.parse(date);
  return {
    title: clean_(title).slice(0, 200), link: String(link || '').trim(),
    pubDate: isNaN(d) ? new Date().toISOString() : new Date(d).toISOString(),
    desc: clean_(desc).slice(0, 240), source: src
  };
}
function tag_(s, name) { var m = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(s); return m ? m[1] : ''; }
function clean_(s) {
  return String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"').replace(/&#8211;|&#8212;/g, '-').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

/* ---------- 3) Gemini ให้คะแนนข่าว (แคชผลต่อหัวข่าว 6 ชม. ประหยัดโควตา) ---------- */
function aiScore_(items) {
  var key = prop_('GEMINI_API_KEY'), model = prop_('GEMINI_MODEL') || 'gemini-flash-latest';
  var cache = CacheService.getScriptCache();
  var list = items.slice(0, 60), keys = list.map(function (it) { return 'ai3_' + hash_(it.title); });
  var got = cache.getAll(keys), todo = [];
  list.forEach(function (it, i) { if (got[keys[i]]) it.ai = JSON.parse(got[keys[i]]); else todo.push(i); });
  if (!todo.length) return;
  todo = todo.slice(0, 40);
  var lines = todo.map(function (idx, k) {
    var it = list[idx];
    return k + '. ' + it.title + (it.desc ? ' — ' + it.desc.slice(0, 160) : '');
  }).join('\n');
  var prompt = 'คุณคือนักวิเคราะห์ตลาดคริปโต ประเมินผลกระทบของข่าวแต่ละข้อต่อราคาเหรียญที่เกี่ยวข้องในระยะสั้น 1-3 วัน\n' +
    'ตอบเป็น JSON array เท่านั้น หนึ่งรายการต่อหนึ่งข่าว รูปแบบ ' +
    '{"i": ลำดับข่าว, "score": จำนวนเต็ม -100 ถึง 100 (ลบ = กดดันราคา, บวก = หนุนราคา, 0 = ไม่มีผล), ' +
    '"coins": ["สัญลักษณ์เหรียญตัวพิมพ์ใหญ่ เช่น BTC, ETH"] หรือ [] ถ้าเป็นข่าวภาพรวมตลาด, ' +
    '"severity": "low" หรือ "mid" หรือ "high", "reason": "เหตุผลภาษาไทยสั้น ๆ ไม่เกิน 80 ตัวอักษร"}\n\n' + lines;
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
  });
  if (res.getResponseCode() !== 200) throw new Error('Gemini HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  var j = JSON.parse(res.getContentText());
  var txt = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
  if (!txt) throw new Error('Gemini ไม่ได้ตอบกลับข้อความ');
  var arr = JSON.parse(txt.replace(/^```(json)?|```$/g, '').trim()), put = {};
  (Array.isArray(arr) ? arr : (arr.items || [])).forEach(function (x) {
    var idx = todo[Number(x.i)];
    if (idx == null) return;
    var v = {
      score: Math.max(-100, Math.min(100, Math.round(Number(x.score) || 0))),
      coins: (x.coins || []).map(String).slice(0, 6),
      severity: String(x.severity || 'low'),
      reason: String(x.reason || '').slice(0, 140)
    };
    list[idx].ai = v;
    put[keys[idx]] = JSON.stringify(v);
  });
  cache.putAll(put, 21600);
}

/* ---------- 4) Fear & Greed ---------- */
function getFng_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('fng3');
  if (hit) return JSON.parse(hit);
  var r = UrlFetchApp.fetch('https://api.alternative.me/fng/?limit=2', { muteHttpExceptions: true });
  var j = JSON.parse(r.getContentText());
  cache.put('fng3', JSON.stringify(j), 1800);
  return j;
}

/* ---------- เครื่องมือ ---------- */
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function hash_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)); }
function host_(u) { var m = /^https?:\/\/([^\/]+)/.exec(u); return m ? m[1].replace(/^www\./, '') : u; }
function out_(o) { return text_(JSON.stringify(o)); }
function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON); }

/** เลือกฟังก์ชันนี้แล้วกด ▶ เรียกใช้ หนึ่งครั้ง เพื่ออนุญาตสิทธิ์และทดสอบการดึงข่าว (ดูผลใน “บันทึกการดำเนินการ”) */
function testNews() {
  CacheService.getScriptCache().removeAll(['news3_ai', 'news3_raw']);
  var r = getNews_(!!prop_('GEMINI_API_KEY'));
  Logger.log('ข่าว ' + r.items.length + ' รายการ จาก ' + r.sources.join(', '));
  if (r.errors.length) Logger.log('ฟีดที่ดึงไม่ได้: ' + r.errors.join(' | '));
  Logger.log(r.aiError ? 'Gemini ผิดพลาด: ' + r.aiError : (r.ai ? 'Gemini ใช้งานได้ · ตัวอย่าง: ' + JSON.stringify(r.items[0].ai) : 'ยังไม่ได้ตั้ง GEMINI_API_KEY (ใช้คลังคำในหน้าเว็บแทน)'));
}
