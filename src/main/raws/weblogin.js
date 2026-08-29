// 网页标题的「真实渲染 + 应用内登录」获取（仅桌面端能力；Web 模式无 BrowserWindow 时整体跳过）
// 三级回退的第二、三级：
//   2) 隐藏 BrowserWindow 真实渲染页面（带 defaultSession Cookie），轮询 document.title —— 解决 SPA 水合标题；
//   3) 检测到重定向到登录域时，弹出可见小窗让用户在应用内登录一次（Cookie 持久化到 defaultSession），
//      登录后读当前页标题；之后同站点链接在第二级即可直接带 Cookie 取到标题。
// 第一级（匿名 fetch 元数据）与兜底（补填/改名）仍在 files.js / 渲染层，本模块不重复。
const electron = require('electron');
const { pickPageTitle, isPlaceholderTitle } = require('./files');
const urlcookies = require('./urlcookies');

const UA = 'Mozilla/5.0 (personal-kb)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasBrowser() {
  return !!electron.BrowserWindow;
}

// 登录成功后把 defaultSession 的全部 Cookie 导出持久化（按域存储），
// 供 Web 模式服务端抓取注入、以及下次启动回填会话
async function persistSessionCookies() {
  try {
    const s = electron.session && electron.session.defaultSession;
    if (!s || !s.cookies) return 0;
    const cookies = await s.cookies.get({});
    return urlcookies.storeCookies(cookies);
  } catch (_) { return 0; }
}

// 登录域特征：hostname 命中即认为「还在登录流程里」
function looksLikeLoginUrl(u) {
  try {
    const h = String(new URL(u).hostname).toLowerCase();
    return /(^|\.)?(login|passport|sso|signin|auth|account|prelogin)[.-]/.test(h) || h.includes('login') || h.includes('passport') || h.includes('sso');
  } catch (_) {
    return false;
  }
}

// 轮询隐藏/可见窗口的 document.title，等 SPA 水合写出真标题
async function readLiveTitle(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!win || win.isDestroyed()) return '';
    try {
      const t = String(await win.webContents.executeJavaScript('document.title')).trim();
      if (t && !isPlaceholderTitle(t)) return t;
    } catch (_) { /* 页面切换瞬间执行失败，忽略继续轮询 */ }
    if (Date.now() > deadline) return '';
    await sleep(400);
  }
}

// 第二级：隐藏窗口真实渲染。返回 { title, finalUrl, login }
// 注意：SSO 站点常见多跳重定向（如 aliyuque/login → ssoLogin → preLogin2），
// 且中途 loadURL 可能抛 ERR_ABORTED；需同时监听重定向事件并在错误后延迟复查。
async function renderPageTitle(url, timeoutMs) {
  const { BrowserWindow, session } = electron;
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, session: session.defaultSession },
  });
  let sawLoginRedirect = false; // 重定向链中任一跳命中登录域即置位
  let lastUrl = url;
  const note = (u) => { if (!u) return; lastUrl = u; if (looksLikeLoginUrl(u)) sawLoginRedirect = true; };
  try {
    win.webContents.on('did-redirect-navigation', (e, u) => note(u));
    win.webContents.on('will-redirect', (e, u) => note(u));
    win.webContents.on('did-navigate', (e, u) => note(u));
    let loadErr = null;
    await win.loadURL(url).catch((e) => { loadErr = e; });
    if (loadErr) {
      // ERR_ABORTED 常见于 SSO 多跳重定向中途；给重定向链一点时间落地再判定
      await sleep(2500);
      try { if (!win.isDestroyed()) note(win.webContents.getURL()); } catch (_) { /* 忽略 */ }
      return { title: '', finalUrl: lastUrl, login: sawLoginRedirect };
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cur = win.webContents.getURL();
      note(cur);
      if (sawLoginRedirect) return { title: '', finalUrl: cur, login: true };
      let t = '';
      try { t = String(await win.webContents.executeJavaScript('document.title')).trim(); } catch (_) { /* 忽略 */ }
      if (t && !isPlaceholderTitle(t)) return { title: t.slice(0, 120), finalUrl: cur, login: false };
      if (Date.now() > deadline) return { title: '', finalUrl: cur, login: sawLoginRedirect };
      await sleep(400);
    }
  } catch (_) {
    return { title: '', finalUrl: lastUrl, login: sawLoginRedirect };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

let loginWin = null; // 单例：同一时间只开一个登录窗，避免连点叠加

// 第三级：弹出可见窗口让用户在应用内完成登录（Cookie 存入 defaultSession，长期复用）。
// 判定「登录完成」：导航回目标域名且不再是登录域 → 等水合后读标题。
// credentials 可选 { username, password }：自动填充常见登录表单，省去手输。
async function loginAndFetchTitle(url, timeoutMs, credentials) {
  const { BrowserWindow, session } = electron;
  if (loginWin && !loginWin.isDestroyed()) return { ok: false, error: '已有一个登录窗口，请先在那里完成登录' };
  let targetHost = '';
  try { targetHost = new URL(url).hostname; } catch (_) { return { ok: false, error: '链接无效' }; }
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: '登录 ' + targetHost + '（完成后自动继续）',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, session: session.defaultSession },
  });
  loginWin = win;

  // 凭据自动填充：等登录表单出现后写入用户名/密码。
  // 站点千差万别，只做「尽力而为」：找第一个可见的 text/email/用户名输入框与 password 框。
  const tryAutofill = async () => {
    if (!credentials || win.isDestroyed()) return;
    const u = String(credentials.username || '').trim();
    const p = String(credentials.password || '');
    if (!u && !p) return;
    try {
      await win.webContents.executeJavaScript(`(() => {
        const vis = (el) => el && el.offsetParent !== null;
        const inputs = [...document.querySelectorAll('input')].filter(vis);
        const userEl = inputs.find((i) => /text|email/i.test(i.type || 'text') && !i.readOnly)
          || inputs.find((i) => /user|account|email|login|name/i.test((i.name || '') + (i.id || '') + (i.placeholder || '')));
        const passEl = inputs.find((i) => i.type === 'password');
        const set = (el, v) => {
          if (!el || !v) return;
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
          if (setter) setter.call(el, v); else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(userEl, ${JSON.stringify(u)});
        set(passEl, ${JSON.stringify(p)});
        return !!(userEl || passEl);
      })()`);
    } catch (_) { /* 页面未就绪/切换中，忽略；用户仍可手输 */ }
  };

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, error: '登录超时' }), timeoutMs);
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      loginWin = null;
      resolve(res);
    };
    win.on('closed', () => finish({ ok: false, error: '登录窗口已关闭' }));
    const stillLoggingIn = (u) => {
      if (looksLikeLoginUrl(u)) return true;
      // 回跳目标域但仍在登录路径（如 aliyuque.antfin.com/login?redirect=...）：继续等
      try {
        const p = new URL(u).pathname.toLowerCase();
        return /\/(login|signin|sign-in|sso|auth)(\/|$|\?)/.test(p) || p.startsWith('/login');
      } catch (_) { return false; }
    };
    const check = async () => {
      if (settled || win.isDestroyed()) return;
      const cur = win.webContents.getURL();
      let sameSite = false;
      try { sameSite = new URL(cur).hostname === targetHost; } catch (_) { /* 忽略 */ }
      if (!sameSite || stillLoggingIn(cur)) return; // 还在 SSO/登录流程，继续等
      const t = await readLiveTitle(win, 15000);
      await persistSessionCookies(); // 登录态落库，供 Web 模式/下次启动复用
      finish(t ? { ok: true, title: t } : { ok: false, error: '登录后仍未读到标题' });
    };
    // 自动填充只在新页面加载完成时尝试一次（不在 did-navigate-in-page 上重复触发，避免覆盖用户手输）
    win.webContents.on('did-finish-load', () => { tryAutofill(); check(); });
    win.webContents.on('did-navigate', () => { tryAutofill(); check(); });
    win.webContents.on('did-navigate-in-page', check);
    // SSO 多跳重定向中途常抛 ERR_ABORTED，不代表失败；由导航事件驱动完成判定
    win.loadURL(url).catch(() => { /* 忽略，交给导航事件判定 */ });
  });
}

// 带登录态（defaultSession Cookie）再抓一次服务端元数据标题：部分站点登录后 SSR 即带 og:title
async function fetchTitleWithSession(url) {
  const s = electron.session && electron.session.defaultSession;
  if (!s || typeof s.fetch !== 'function') return '';
  const resp = await s.fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' });
  if (!resp.ok) return '';
  return pickPageTitle(await resp.text());
}

// 隐藏窗真实渲染并提取正文（取文档内容用，区别于只取标题）：
// 带 defaultSession Cookie 加载，等 SPA 水合后抽取正文文本。
// 返回 { ok, title, body, login }：login=true 表示被重定向到登录页（需先登录）。
async function renderPageBody(url, timeoutMs) {
  const { BrowserWindow, session } = electron;
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, session: session.defaultSession },
  });
  let sawLoginRedirect = false;
  const note = (u) => { if (u && looksLikeLoginUrl(u)) sawLoginRedirect = true; };
  try {
    win.webContents.on('did-redirect-navigation', (e, u) => note(u));
    win.webContents.on('will-redirect', (e, u) => note(u));
    win.webContents.on('did-navigate', (e, u) => note(u));
    await win.loadURL(url).catch(() => { /* 交给后续轮询判定 */ });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (win.isDestroyed()) return { ok: false, title: '', body: '', login: sawLoginRedirect };
      const cur = win.webContents.getURL();
      note(cur);
      if (sawLoginRedirect) return { ok: false, title: '', body: '', login: true };
      let data = null;
      try {
        data = await win.webContents.executeJavaScript(`(() => {
          const title = (document.title || '').trim();
          // 正文优先取常见文档容器中最长的，都不够长再退到 body 全文
          const sel = ['article', 'main', '[class*="doc"]', '[class*="article"]', '[class*="content"]'];
          let text = '';
          for (const s of sel) {
            const el = document.querySelector(s);
            const t = el ? (el.innerText || '').trim() : '';
            if (t.length > text.length) text = t;
          }
          if (text.length < 80) text = (document.body.innerText || '').trim();
          return { title, text };
        })()`);
      } catch (_) { /* 页面切换瞬间，忽略继续轮询 */ }
      if (data && data.text && data.text.length > 80) {
        return { ok: true, title: data.title || '', body: data.text, login: false };
      }
      if (Date.now() > deadline) return { ok: false, title: (data && data.title) || '', body: '', login: sawLoginRedirect };
      await sleep(400);
    }
  } catch (_) {
    return { ok: false, title: '', body: '', login: sawLoginRedirect };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// 编排：第二级 →（需登录时）第三级 → 带 Cookie 的元数据补刀。
// 返回 { title, login, supported }；supported=false 表示当前环境无渲染能力（Web 模式），调用方直接走兜底。
// credentials 可选 { username, password }，透传给登录窗自动填充。
async function resolveUrlTitle(url, timeoutSec, credentials) {
  if (!hasBrowser()) return { title: '', login: false, supported: false };
  const timeoutMs = Math.max(5, Math.min(20, timeoutSec || 20)) * 1000;
  const r = await renderPageTitle(url, timeoutMs);
  if (r.title) return { title: r.title, login: false, supported: true };
  if (!r.login) return { title: '', login: false, supported: true };
  const lr = await loginAndFetchTitle(url, 5 * 60 * 1000, credentials);
  if (lr.ok && lr.title) return { title: lr.title, login: true, supported: true };
  try {
    const t = await fetchTitleWithSession(url);
    if (t) return { title: t, login: true, supported: true };
  } catch (_) { /* 补刀失败不影响兜底 */ }
  return { title: '', login: true, supported: true };
}

module.exports = { hasBrowser, resolveUrlTitle, renderPageTitle, renderPageBody, loginAndFetchTitle, looksLikeLoginUrl, persistSessionCookies };
