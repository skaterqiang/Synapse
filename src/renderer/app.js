// 渲染进程·入口：事件绑定与初始化装配
// ================= 事件绑定 =================
function bindEvents() {
  // 新建 / 删除 / 置顶 / 导出
  $('btn-new-note').addEventListener('click', (e) => {
    e.stopPropagation(); // 避免触发「全部笔记」导航切换
    promptCreateNote(null);
  });
  // 侧边栏「全部笔记」右键：全部笔记提取 Wiki / 知识图谱（按钮入口已统一为右键）
  $('nav-all-notes').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCtxMenu(e.clientX, e.clientY, [
      { label: '📝 全部笔记提取 Wiki', action: () => notesToWiki(state.notes.slice(), '全部笔记', '全部笔记') },
      { label: '🕸 全部笔记提取知识图谱', action: () => notesToGraph(state.notes.slice(), '全部笔记') },
    ]);
  });
  $('btn-delete').addEventListener('click', deleteNote);
  $('btn-pin').addEventListener('click', () => {
    const note = currentNote();
    if (!note) return;
    note.pinned = !note.pinned;
    persist();
    renderAll();
  });
  $('btn-export').addEventListener('click', async () => {
    const note = currentNote();
    if (!note) return;
    const res = await window.kb.noteOpenFolder({ folderId: note.folderId });
    if (!res.ok) toast('无法打开文件夹：' + (res.error || '未知错误'), 3000);
  });

  // 全部笔记
  $('nav-all-notes').addEventListener('click', () => {
    state.view = { type: 'all', id: null, query: '' };
    $('search-input').value = '';
    hideMainViews();
    // 列表被收起时，点击“全部笔记”重新展开列表
    if (state.noteListHidden) setNoteListHidden(false);
    renderAll();
  });

  // 新建目录
  $('btn-add-folder').addEventListener('click', async () => {
    const name = await askInput('新目录名称：');
    if (!name || !name.trim()) return;
    state.folders.push({ id: uid(), name: name.trim(), parentId: null });
    persist();
    renderAll();
  });

  // 搜索
  $('search-input').addEventListener('input', (e) => {
    const q = e.target.value;
    state.view = q.trim()
      ? { type: 'search', id: null, query: q.trim() }
      : { type: 'all', id: null, query: '' };
    if (q.trim() && state.noteListHidden) setNoteListHidden(false);
    renderAll();
  });

  // 编辑区输入（防抖更新）
  let editTimer = null;
  const onEdit = () => {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      updateNoteFromEditor();
      updatePreview();
      renderNoteList();
      renderSidebar();
    }, 300);
  };
  $('note-title').addEventListener('input', onEdit);
  $('note-content').addEventListener('input', onEdit);
  $('note-tags').addEventListener('change', () => {
    updateNoteFromEditor();
    renderAll();
  });
  $('note-folder').addEventListener('change', () => {
    const note = currentNote();
    if (!note) return;
    note.folderId = $('note-folder').value || null;
    note.updatedAt = Date.now();
    persist();
    renderNoteList();
    renderSidebar();
  });

  // 编辑模式切换
  ['edit', 'split', 'preview'].forEach((m) => {
    $('mode-' + m).addEventListener('click', () => {
      state.editorMode = m;
      applyEditorMode();
      updatePreview();
    });
  });

  // AI 面板（分隔条随面板显隐）
  $('btn-ai-toggle').addEventListener('click', () => {
    setAiPanelVisible($('ai-panel').hidden);
    if (!$('ai-panel').hidden) $('ai-input').focus();
  });
  $('btn-ai-close').addEventListener('click', () => { setAiPanelVisible(false); });
  $('btn-ai-clear').addEventListener('click', () => {
    aiHistory = [];
    $('ai-messages').innerHTML = '';
  });
  $('btn-ai-send').addEventListener('click', sendAiQuestion);
  $('ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAiQuestion();
    }
  });

  // 设置（主区域 Tab 页）
  $('btn-settings').addEventListener('click', showSettingsView);
  $('btn-notelist-hide').addEventListener('click', () => setNoteListHidden(true));
  $('btn-notelist-show').addEventListener('click', () => setNoteListHidden(false));
  $('btn-settings-close').addEventListener('click', hideSettingsView);
  $('btn-settings-save').addEventListener('click', saveSettings);
  $('settings-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchSettingsTab(btn.dataset.tab);
  });

  // ---------- LLM Wiki ----------
  $('wiki-header').addEventListener('click', (e) => {
    if (e.target.closest('#btn-wiki-ingest')) return; // ＋ 按钮不触发列表切换
    // 点击标题：在中间列表区按索引展示全部 Wiki 页面
    state.view = { type: 'wiki', id: null, query: '' };
    $('search-input').value = '';
    // 主内容区已开的专题页一并让位，否则作业/图谱等页会留在右侧
    hideMainViews({ keepWikiViewer: true });
    if (state.noteListHidden) setNoteListHidden(false);
    renderAll();
  });
  $('btn-wiki-ingest').addEventListener('click', openIngestModal);
  $('btn-wiki-close').addEventListener('click', closeWikiViewer);
  $('btn-wiki-source').addEventListener('click', () => {
    const body = $('wiki-body');
    const raw = $('wiki-raw-text');
    const showRaw = body.hidden === false;
    body.hidden = showRaw;
    raw.hidden = !showRaw;
  });
  // Wiki 页面内部 md 链接导航
  $('wiki-body').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href.endsWith('.md')) return;
    e.preventDefault();
    openWikiPage(resolveWikiPath(state.wikiPage || '', href));
  });

  // 吸收弹窗
  $('ingest-tab-url').addEventListener('click', () => switchIngestTab('url'));
  $('ingest-tab-text').addEventListener('click', () => switchIngestTab('text'));
  $('ingest-tab-files').addEventListener('click', () => switchIngestTab('files'));
  $('btn-pick-files').addEventListener('click', async () => {
    const res = await window.kb.wikiPickFiles();
    if (res && res.ok && res.paths.length) addIngestFiles(res.paths);
  });
  // 拖拽上传：拖到弹窗任意位置均可
  const modal = $('ingest-modal');
  ['dragenter', 'dragover'].forEach((evt) => {
    modal.addEventListener(evt, (e) => {
      e.preventDefault();
      if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) {
        if (state.ingestTab !== 'files') switchIngestTab('files');
        $('file-drop').classList.add('dragover');
      }
    });
  });
  modal.addEventListener('dragleave', (e) => {
    if (e.target === modal) $('file-drop').classList.remove('dragover');
  });
  modal.addEventListener('drop', (e) => {
    e.preventDefault();
    $('file-drop').classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length) {
      if (state.ingestTab !== 'files') switchIngestTab('files');
      addIngestFiles(paths);
    }
  });
  $('btn-ingest-go').addEventListener('click', runIngest);
  $('btn-ingest-cancel').addEventListener('click', () => { $('ingest-modal').hidden = true; });
  $('ingest-modal').addEventListener('click', (e) => {
    if (e.target === $('ingest-modal')) $('ingest-modal').hidden = true;
  });

  // Lint 弹窗
  $('btn-lint-close').addEventListener('click', () => { $('lint-modal').hidden = true; });
  $('lint-modal').addEventListener('click', (e) => {
    if (e.target === $('lint-modal')) $('lint-modal').hidden = true;
  });

  // 作业管理页
  $('nav-jobs').addEventListener('click', showJobsView);
  $('btn-jobs-close').addEventListener('click', hideJobsView);
  // 提示词管理页
  $('nav-prompts').addEventListener('click', showPromptsView);
  $('btn-prompts-close').addEventListener('click', hidePromptsView);
  $('btn-jobs-new-lint').addEventListener('click', runLint);
  $('btn-jobs-clear').addEventListener('click', clearJobsHistory);
  $('jobs-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    state.jobsFilter = btn.dataset.filter;
    renderJobsView();
  });

  // AI 数据源多选
  loadAiSources();
  bindAiSources();
  applyAiSources();

  // 快捷键：Ctrl+N 新建，Ctrl+F 聚焦搜索
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      createNote();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search-input').focus();
    }
  });
}

// ================= 初始化 =================
async function init() {
  marked.setOptions({ breaks: true, gfm: true });
  const store = await window.kb.loadData();
  state.folders = store.folders || [];
  state.notes = store.notes || [];
  state.settings = store.settings || {};

  // 首次使用生成示例笔记
  if (state.notes.length === 0) {
    state.notes.push({
      id: uid(),
      title: '👋 欢迎使用个人知识库助手',
      content: [
        '## 快速上手',
        '',
        '- **新建笔记**：左上角"＋ 新建"按钮，或快捷键 `Ctrl + N`',
        '- **搜索**：左侧搜索框，或快捷键 `Ctrl + F`，支持标题、内容、标签全文检索',
        '- **目录与标签**：左侧可创建多级目录；标签在笔记元信息栏中用逗号分隔填写',
        '- **编辑模式**：工具栏可切换 编辑 / 分屏 / 预览 三种模式',
        '',
        '## Markdown 语法示例',
        '',
        '1. 有序列表',
        '- 无序列表',
        '',
        '> 引用块效果',
        '',
        '```js',
        'console.log("代码块高亮");',
        '```',
        '',
        '## AI 智能问答',
        '',
        '点击左下角 **🤖 AI 问答** 打开对话面板，在 **⚙ 设置** 中配置任意兼容 OpenAI 格式的接口',
        '（如 DeepSeek、通义千问、Ollama 本地模型等），即可基于你的笔记内容进行问答。',
      ].join('\n'),
      tags: ['指南'],
      folderId: null,
      pinned: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    persist();
  }

  bindEvents();
  bindEditorToolbar();
  bindGraphEvents();
  bindTplEvents();
  bindRawEvents();
  state.noteListHidden = localStorage.getItem('kb.noteListHidden') === '1';
  initResizers();
  // 默认编辑器模式读设置（缺省分屏）
  state.editorMode = EDITOR_MODES.includes(state.settings.defaultEditorMode) ? state.settings.defaultEditorMode : 'split';
  renderAll();
  loadWiki();
  loadGraph();
  loadTemplates();
  loadRaws();
  window.kb.onJobsUpdate(handleJobsUpdate);
  window.kb.jobsList().then((list) => { state.jobs = list || []; renderJobs(); });
  if (state.notes.length) selectNote(getFilteredNotes()[0]?.id || state.notes[0].id);
}

init();
