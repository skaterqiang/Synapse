// 链接来源登录态（Cookie）持久化：
// 桌面端登录窗把凭据换来的 Cookie 留在 Electron defaultSession（供隐藏窗渲染复用），
// 但 Web 模式没有 BrowserWindow，服务端 fetch 也拿不到会话。统一做法：
// 登录成功后把 Cookie 按各自域名序列化存入 kv（url_cookies），
// 任何模式下服务端抓取都可按域匹配注入；桌面端启动时再回填 defaultSession。
// 按 Cookie 自身域名（而非登录入口 URL）存储，天然兼容 SSO 多域跳转场景。
const db = require('../common/db');

const KEY = 'url_cookies';

function loadAll() {
  try { return JSON.parse(db.getKv(KEY) || '{}'); } catch (_) { return {}; }
}

function saveAll(map) {
  db.setKv(KEY, JSON.stringify(map));
  db.flush();
}

// 只保留可复用的字段；空值 Cookie 无意义直接丢弃
function simplify(c) {
  return {
    name: c.name,
    value: c.value,
    domain: String(c.domain || '').toLowerCase().replace(/^\./, ''),
    path: c.path || '/',
    expirationDate: c.expirationDate,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
}

// 保存一批 Cookie（登录成功后从 defaultSession 整体导出）：
// 按域名分组、同名同路径覆盖更新。返回实际保存条数。
function storeCookies(cookies) {
  const map = loadAll();
  let n = 0;
  for (const raw of cookies || []) {
    const c = simplify(raw);
    if (!c.name || c.value === undefined || c.value === '' || !c.domain) continue;
    if (!map[c.domain]) map[c.domain] = { at: Date.now(), cookies: [] };
    map[c.domain].at = Date.now();
    const arr = map[c.domain].cookies;
    const idx = arr.findIndex((x) => x.name === c.name && (x.path || '/') === c.path);
    if (idx >= 0) arr[idx] = c;
    else arr.push(c);
    n++;
  }
  if (n) saveAll(map);
  return n;
}

// 取与目标 URL 匹配的 Cookie（hostname 相等或为其父域，如 yuque.com 覆盖 www.yuque.com）
function getCookiesForUrl(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return []; }
  const map = loadAll();
  const out = [];
  const seen = new Set();
  // 更具体的域名优先（子域 Cookie 覆盖父域同名项）
  const domains = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const d of domains) {
    if (!d) continue;
    if (host !== d && !host.endsWith('.' + d)) continue;
    for (const c of (map[d] && map[d].cookies) || []) {
      const k = c.name + '@' + (c.path || '/');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

// 拼请求头用的 Cookie 字符串（服务端 fetch 注入登录态）；无匹配返回空串
function cookieHeaderForUrl(url) {
  const list = getCookiesForUrl(url);
  return list.map((c) => `${c.name}=${c.value}`).join('; ');
}

// 桌面端启动时把已存 Cookie 回填 defaultSession（隐藏窗渲染即可直接带登录态）。
// 会话级 Cookie（无过期时间）设 7 天后过期：cookies.set 需要明确过期值，且避免登录态无限期残留
async function restoreToSession(session) {
  if (!session || !session.cookies) return 0;
  let n = 0;
  for (const rec of Object.values(loadAll())) {
    for (const c of (rec && rec.cookies) || []) {
      if (!c.domain || !c.name) continue;
      const url = `${c.secure ? 'https' : 'http'}://${c.domain}/`;
      try {
        await session.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: c.expirationDate || Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        });
        n++;
      } catch (_) { /* 单条失败不影响其余 */ }
    }
  }
  return n;
}

module.exports = { storeCookies, getCookiesForUrl, cookieHeaderForUrl, restoreToSession };
