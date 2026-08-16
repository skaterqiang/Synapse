const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kb', {
  // 数据
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (store) => ipcRenderer.invoke('data:save', store),
  setDbPath: (p) => ipcRenderer.invoke('data:setDbPath', p),

  // AI 问答（流式）
  askAI: (payload) => ipcRenderer.invoke('ai:ask', payload),
  onAiChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on('ai:chunk', handler);
    return () => ipcRenderer.removeListener('ai:chunk', handler);
  },
  onAiDone: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('ai:done', handler);
    return () => ipcRenderer.removeListener('ai:done', handler);
  },
  onAiError: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('ai:error', handler);
    return () => ipcRenderer.removeListener('ai:error', handler);
  },

  // LLM Wiki
  wikiDefaultRoot: () => ipcRenderer.invoke('wiki:defaultRoot'),
  wikiDescribe: (settings) => ipcRenderer.invoke('wiki:describe', settings),
  wikiRead: (payload) => ipcRenderer.invoke('wiki:read', payload),
  wikiPickFiles: () => ipcRenderer.invoke('wiki:pickFiles'),
  wikiAsk: (payload) => ipcRenderer.invoke('wiki:ask', payload),
  wikiFileAnswer: (payload) => ipcRenderer.invoke('wiki:fileAnswer', payload),
  onWikiRefs: (callback) => {
    const handler = (_event, refs) => callback(refs);
    ipcRenderer.on('wiki:refs', handler);
    return () => ipcRenderer.removeListener('wiki:refs', handler);
  },

  // 领域模版
  tplList: () => ipcRenderer.invoke('tpl:list'),
  tplSave: (tpl) => ipcRenderer.invoke('tpl:save', tpl),
  tplRemove: (id) => ipcRenderer.invoke('tpl:remove', id),
  tplGenerate: (payload) => ipcRenderer.invoke('tpl:generate', payload),
  tplSuggest: (payload) => ipcRenderer.invoke('tpl:suggest', payload),
  tplMatchPrompt: () => ipcRenderer.invoke('tpl:matchPrompt'),
  tplMatchFor: (payload) => ipcRenderer.invoke('tpl:matchFor', payload), // 吸收前领域模板预检查
  tplSuggestName: (payload) => ipcRenderer.invoke('tpl:suggestName', payload), // 未命中后按来源内容归纳领域名称（供新建弹窗自动填充）
  promptsDefs: () => ipcRenderer.invoke('prompts:defs'),

  // 原始文件管理
  rawList: (settings) => ipcRenderer.invoke('raw:list', settings),
  rawOpen: (payload) => ipcRenderer.invoke('raw:open', payload),
  rawRemove: (payload) => ipcRenderer.invoke('raw:remove', payload),
  rawAddFiles: (payload) => ipcRenderer.invoke('raw:addFiles', payload),
  rawAddDir: (payload) => ipcRenderer.invoke('raw:addDir', payload),
  browseDir: (payload) => ipcRenderer.invoke('raw:browse', payload),

  // 作业管理
  jobsList: () => ipcRenderer.invoke('jobs:list'),
  jobsSubmit: (payload) => ipcRenderer.invoke('jobs:submit', payload),
  jobsRemove: (id) => ipcRenderer.invoke('jobs:remove', id),
  jobsClear: () => ipcRenderer.invoke('jobs:clear'),
  jobsRetry: (payload) => ipcRenderer.invoke('jobs:retry', payload),
  onJobsUpdate: (callback) => {
    const handler = (_event, list) => callback(list);
    ipcRenderer.on('jobs:update', handler);
    return () => ipcRenderer.removeListener('jobs:update', handler);
  },

  // 其他
  exportNote: (options) => ipcRenderer.invoke('dialog:export', options),
  getDataPath: () => ipcRenderer.invoke('app:getDataPath'),
  dataRoot: () => ipcRenderer.invoke('app:dataRoot'),
  setDataRoot: (p) => ipcRenderer.invoke('data:setRoot', p),

  // 知识图谱
  graphGet: () => ipcRenderer.invoke('graph:get'),
  graphClear: () => ipcRenderer.invoke('graph:clear'),
  graphOntology: () => ipcRenderer.invoke('graph:ontology'),
  ontoSave: (payload) => ipcRenderer.invoke('onto:save', payload),
  ontoRemove: (payload) => ipcRenderer.invoke('onto:remove', payload),
  graphAsk: (payload) => ipcRenderer.invoke('graph:ask', payload),
  onKgFacts: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('kg:facts', handler);
    return () => ipcRenderer.removeListener('kg:facts', handler);
  },
  onKgStage: (callback) => {
    const handler = (_e, text) => callback(text);
    ipcRenderer.on('kg:stage', handler);
    return () => ipcRenderer.removeListener('kg:stage', handler);
  },

  // 笔记附件与 AI 扫描
  notePickImage: (opts) => ipcRenderer.invoke('note:pickImage', opts),
  noteSaveImage: (payload) => ipcRenderer.invoke('note:saveImage', payload),
  noteScan: (payload) => ipcRenderer.invoke('note:scan', payload),
  noteOpenFolder: (payload) => ipcRenderer.invoke('note:openFolder', payload),
  noteAiAssist: (payload) => ipcRenderer.invoke('note:aiAssist', payload),
  noteSaveVersion: (payload) => ipcRenderer.invoke('note:saveVersion', payload),
  noteListVersions: (payload) => ipcRenderer.invoke('note:listVersions', payload),
  noteGetVersion: (payload) => ipcRenderer.invoke('note:getVersion', payload),
  noteDeleteVersions: (payload) => ipcRenderer.invoke('note:deleteVersions', payload),
});
