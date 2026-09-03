// Synapse Web 桥接：替代 Electron preload 暴露的 window.kb
// invoke 类方法 → POST /api/call/:channel；事件监听 → SSE (/api/events)
(function () {
  window.__KB_WEB__ = true; // 网页模式标记：渲染层据此改写 kb-asset 图片地址
  const subs = {
    'ai:chunk': [],
    'ai:step': [],
    'ai:done': [],
    'ai:error': [],
    'tpl:gen-chunk': [],
    'jobs:update': [],
    'jobs:log': [],
    'kg:facts': [],
    'kg:stage': [],
    'mineru:test-log': [],
    'mineru:install-log': [],
    'skill:install-log': [],
    'ai:refs': [],
    'ai:assist-chunk': [],
    'tpl:match-chunk': [],
    'tpl:suggest-profile-chunk': [],
  };

  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      const { channel, data } = JSON.parse(e.data);
      (subs[channel] || []).forEach((cb) => cb(data));
    } catch (_) { /* 忽略异常帧 */ }
  };

  function on(channel) {
    return (callback) => {
      subs[channel].push(callback);
      return () => {
        subs[channel] = subs[channel].filter((cb) => cb !== callback);
      };
    };
  }

  async function call(channel, body) {
    const res = await fetch('/api/call/' + encodeURIComponent(channel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body === undefined ? null : body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `请求失败 (${res.status})`);
    return json.result;
  }

  window.kb = {
    // 运行环境标识：Web 模式为 false（桌面版 preload 为 true）
    isElectron: false,
    // 数据
    loadData: () => call('data:load'),
    saveData: (store) => call('data:save', store),
    setDbPath: (p) => call('data:setDbPath', p),

    // AI 问答（流式事件经 SSE 下发）
    askAI: (payload) => call('ai:ask', payload),
    aiStop: () => call('ai:stop'),
    listModels: (settings) => call('ai:listModels', settings),
    onAiChunk: on('ai:chunk'),
    onAiDone: on('ai:done'),
    onAiError: on('ai:error'),
    onAiStep: on('ai:step'),

    onTplGenChunk: on('tpl:gen-chunk'),
    onTplMatchChunk: on('tpl:match-chunk'),
    onTplSuggestProfileChunk: on('tpl:suggest-profile-chunk'),
    onAiRefs: on('ai:refs'),
    onAiAssistChunk: on('ai:assist-chunk'),
    aiAssistStop: () => call('note:aiAssistStop'),

    // 领域模版
    tplList: () => call('tpl:list'),
    tplSave: (tpl) => call('tpl:save', tpl),
    tplRemove: (id) => call('tpl:remove', id),
    tplGenerate: (payload) => call('tpl:generate', payload),
    tplSuggest: (payload) => call('tpl:suggest', payload),
    tplMatchPrompt: () => call('tpl:matchPrompt'),
    tplProfileTree: (profileId) => call('tpl:profileTree', profileId),
    tplMatchFor: (payload) => call('tpl:matchFor', payload),
    tplSuggestName: (payload) => call('tpl:suggestName', payload),
    tplSuggestProfile: (payload) => call('tpl:suggestProfile', payload),
    promptsDefs: () => call('prompts:defs'),

    // 原始文件管理（目录选择在浏览器不可用，返回 canceled 由前端提示）
    rawList: (settings) => call('raw:list', settings),
    rawSearch: (payload) => call('raw:search', payload),
    rawExtractNote: (payload) => call('raw:extractNote', payload),
    mineruTest: (payload) => call('mineru:test', payload),
    onMineruTestLog: on('mineru:test-log'),
    mineruInstall: (payload) => call('mineru:install', payload),
    mineruApplyModel: (payload) => call('mineru:apply-model', payload),
    onMineruInstallLog: on('mineru:install-log'),
    knowledgeSources: () => call('knowledge:sources'),
    knowledgeRetrieve: (payload) => call('knowledge:retrieve', payload),
    readAttachments: (payload) => call('ai:readAttachments', payload),
    rawAddUrl: (payload) => call('raw:addUrl', payload),
    rawRenameUrl: (payload) => call('raw:renameUrl', payload),
    skillRead: (payload) => call('skill:read', payload),
    skillInstall: (payload) => call('skill:install', payload),
    onSkillInstallLog: on('skill:install-log'),
    chatGetHistory: () => call('chat:getHistory'),
    chatSaveHistory: (list) => call('chat:saveHistory', list),
    chatGetSessions: () => call('chat:getSessions'),
    chatSaveSessions: (list) => call('chat:saveSessions', list),
    mcpTest: (cfg) => call('mcp:test', cfg),
    skillRun: (payload) => call('skill:run', payload),
    openPath: (payload) => call('shell:openPath', payload),
    revealPath: (payload) => call('shell:revealPath', payload),
    readDoc: (payload) => call('docs:read', payload),
    rawPickDir: () => Promise.resolve({ ok: false, canceled: false }),
    openExternal: (url) => { try { window.open(url, '_blank'); return Promise.resolve({ ok: true }); } catch (e) { return Promise.resolve({ ok: false, error: e.message }); } },
    rawOpen: () => Promise.resolve({ ok: false, error: '网页模式不支持打开本地文件，请在桌面端使用' }),
    rawRemove: (payload) => call('raw:remove', payload),
    rawRemoveDir: (payload) => call('raw:removeDir', payload),
    rawAddFiles: (payload) => call('raw:addFiles', payload),
    rawAddDir: (payload) => call('raw:addDir', payload),
    browseDir: () => Promise.resolve({ ok: false, error: '网页模式不支持浏览本地目录' }),

    // 作业管理
    jobsList: () => call('jobs:list'),
    jobsSubmit: (payload) => call('jobs:submit', payload),
    jobsRemove: (id) => call('jobs:remove', id),
    jobsClear: () => call('jobs:clear'),
    jobsRetry: (payload) => call('jobs:retry', payload),
    jobsCancel: (id) => call('jobs:cancel', id),
    onJobsUpdate: on('jobs:update'),
    onJobsLog: on('jobs:log'),
    jobsLogs: (id) => call('jobs:logs', { id }),

    // 其他
    getDataPath: () => call('app:getDataPath'),
    dataRoot: () => call('app:dataRoot'),
    setDataRoot: (p) => call('data:setRoot', p),

    // 知识图谱
    graphGet: () => call('graph:get'),
    graphClear: () => call('graph:clear'),
    graphOntology: (profileId) => call('graph:ontology', profileId),
    graphProfiles: () => call('graph:profiles'),
    graphProfilePrompts: (profileId) => call('graph:profilePrompts', profileId),
    graphSaveProfilePrompt: (payload) => call('graph:saveProfilePrompt', payload),
    graphScopes: () => call('graph:scopes'),
    graphResolveSources: (payload) => call('graph:resolveSources', payload),
    ontoSave: (payload) => call('onto:save', payload),
    ontoRemove: (payload) => call('onto:remove', payload),
    ontoSetProfile: (profileId) => call('onto:setProfile', profileId),
    graphAsk: (payload) => call('graph:ask', payload),
    graphImportOwl: (body) => call('graph:importOwl', body),
    graphRemoveOwlProfile: (payload) => call('graph:removeOwlProfile', payload),
    onKgFacts: on('kg:facts'),
    onKgStage: on('kg:stage'),

    // 笔记附件：浏览器端选择文件，图片读为 dataUrl；非图片在 Web 模式不可用
    notePickImage: ({ imagesOnly } = {}) => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = imagesOnly ? 'image/*' : '*/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; input.remove(); resolve(v); } };
      window.addEventListener('focus', () => setTimeout(() => finish({ ok: true, canceled: true }), 500), { once: true });
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return finish({ ok: true, canceled: true });
        const isImage = f.type.startsWith('image/');
        if (!isImage) return finish({ ok: true, name: f.name, path: null, dataUrl: null });
        if (f.size > 4 * 1024 * 1024) return finish({ ok: false, error: '图片超过 4MB，请压缩后再插入' });
        const reader = new FileReader();
        reader.onload = () => finish({ ok: true, name: f.name, path: null, dataUrl: reader.result });
        reader.onerror = () => finish({ ok: false, error: '读取文件失败' });
        reader.readAsDataURL(f);
      };
      input.click();
    }),
    noteScan: (payload) => call('note:scan', payload),
    noteOpenFolder: () => Promise.resolve({ ok: false, error: '网页模式不支持打开本地文件夹' }),
    noteAiAssist: (payload) => call('note:aiAssist', payload),
    noteSaveVersion: (payload) => call('note:saveVersion', payload),
    noteListVersions: (payload) => call('note:listVersions', payload),
    noteGetVersion: (payload) => call('note:getVersion', payload),
    noteDeleteVersions: (payload) => call('note:deleteVersions', payload),
    noteSaveImage: (payload) => call('note:saveImage', payload),

    // 导出笔记：浏览器直接下载，不经过服务端对话框
    exportNote: ({ defaultName, content } = {}) => {
      try {
        const blob = new Blob([content || ''], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = defaultName || 'note.md';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        return Promise.resolve({ ok: true, path: a.download });
      } catch (err) {
        return Promise.resolve({ ok: false, error: err.message });
      }
    },

    // 选择附件文件：页面文件选择 + 上传，返回服务端落盘路径
    rawPickFiles: () => new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);
      let settled = false;
      const finish = (v) => {
        if (!settled) { settled = true; input.remove(); resolve(v); }
      };
      // 关闭选择框未选文件时不会触发 change，借助下一次点击事件兜底
      window.addEventListener('focus', () => setTimeout(() => finish({ ok: true, paths: [] }), 500), { once: true });
      input.onchange = async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return finish({ ok: true, paths: [] });
        const paths = [];
        for (const f of files) {
          try {
            const buf = await f.arrayBuffer();
            const res = await fetch('/api/upload?name=' + encodeURIComponent(f.name), {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: buf,
            });
            const json = await res.json();
            if (json.path) paths.push(json.path);
          } catch (_) { /* 单个文件失败不阻塞其余文件 */ }
        }
        finish({ ok: true, paths });
      };
      input.click();
    }),
  };
})();
