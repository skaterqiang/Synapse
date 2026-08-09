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
});
