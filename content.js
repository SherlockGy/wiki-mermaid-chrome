(function () {
  'use strict';

  // 日志前缀：wikiMermaid 渲染 wiki 代码块中的 mermaid
  const logPrefix = '[wikiMermaid mermaid渲染]';

  // 处理状态标记，避免重复处理：skip=非mermaid / done=已渲染 / error=渲染失败
  // 属性写在 DOM 上，确保同一代码块不会被重复渲染
  const PROCESSED_ATTR = 'data-wiki-mermaid';

  // 原代码块保持在 Wiki 管理的 DOM 中，仅通过独立属性控制显隐，避免 Live Doc 重渲染恢复节点结构
  const HOST_HIDDEN_ATTR = 'data-wiki-mermaid-hidden';

  // 标识状态属于哪个脚本实例：页面克隆旧节点时可识别本实例的失效标记，同时不干扰其他实例
  const OWNER_ATTR = 'data-wiki-mermaid-owner';

  // 同时覆盖 Confluence Server 代码宏、Atlassian Design System 代码块、
  // Live Doc hydration 后的 ProseMirror CodeMirror 节点和常见 pre 代码块。
  const CODE_BLOCK_SELECTOR = 'div.code.panel, [data-ds--code--code-block], [data-prosemirror-node-name="codeBlock"], pre';

  // mermaid 图类型首行识别；graph 必须带方向词，避免把普通英文文本误判成图；
  // -beta 后缀是否可省略按 mermaid 11.16.0 实测：radar/architecture 必须带，sankey/xychart/block/packet/treemap 可省；
  // mindmap/timeline/kanban/block/ishikawa 是自由文法，普通英文散文也能通过 parse（实测），
  // 语法校验挡不住，因此这几个关键字要求独占首行（$ 锚定，合法头部本就单独成行，无损失）
  const DIAGRAM_RE = /^(?:flowchart\b|graph\s+(?:TB|TD|BT|RL|LR)\b|sequenceDiagram\b|classDiagram\b|stateDiagram(?:-v2)?\b|erDiagram\b|journey\b|gantt\b|pie\b|gitGraph\b|mindmap$|timeline$|quadrantChart\b|requirementDiagram\b|C4Context\b|C4Container\b|C4Component\b|C4Dynamic\b|C4Deployment\b|sankey(?:-beta)?\b|xychart(?:-beta)?\b|block(?:-beta)?$|packet(?:-beta)?\b|kanban$|ishikawa$|architecture-beta\b|radar-beta\b|treemap(?:-beta)?\b)/;

  const M = window.mermaid || (typeof mermaid !== 'undefined' ? mermaid : null);
  if (!M) {
    console.warn(logPrefix + ' mermaid 库未加载，脚本退出');
    return;
  }
  M.initialize({ startOnLoad: false, theme: 'default' });

  let seq = 0;

  // 每个脚本实例使用随机前缀，避免 mermaid.render 遇到同名 id 时移除已插入的 SVG
  const RUN = Math.random().toString(36).slice(2, 8);

  // 运行设置：enabled=渲染总开关，collapseLarge=大图默认折叠；
  // 从 chrome.storage.sync 读取运行设置并由 popup 控制；存储 API 不可用时使用默认值
  const DEFAULT_SETTINGS = { enabled: true, collapseLarge: true };
  const settings = Object.assign({}, DEFAULT_SETTINGS);
  const syncStore = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) ? chrome.storage.sync : null;

  // 大图折叠双阈值：a=COLLAPSED_HEIGHT（折叠后展示高度），b=COLLAPSE_TRIGGER（默认折叠触发线），a<b；
  // 高度>b：默认折叠到 a；a<高度≤b：默认不限制，展开栏提供手工收起；高度≤a：不挂展开栏
  const COLLAPSED_HEIGHT = 280;
  const COLLAPSE_TRIGGER = 640;

  // 手动缩放范围和相邻档位倍率：默认按 Mermaid 原始尺寸展示，避免超宽图被压缩后文字不可读
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 4;
  const ZOOM_FACTOR = 1.25;
  const DIAGRAM_PADDING = 12;

  // 拖动模式为页面工具栏等区域预留高度，使超高图形在当前屏幕内形成可上下拖动的视口
  const PAN_VIEWPORT_RESERVED_HEIGHT = 160;
  const PAN_EDGE_SPACE_RATIO = 0.5;

  // 本实例已渲染的图形块，供总开关/折叠开关即时生效
  const rendered = [];
  const processingPanels = new WeakSet();
  let pageFullscreenItem = null;

  // mermaid 串行队列：parse 会按 %%{init}%% 指令改写全局配置，render 依赖 document 做临时测量，均非可重入；
  // 每个块的 parse+render 作为一个原子任务排队，避免 A 块渲染途中被 B 块的 parse 改掉配置
  let mermaidChain = Promise.resolve();
  function mermaidSerialized(task) {
    const run = mermaidChain.then(task);
    mermaidChain = run.then(function () {}, function () {}); // 单块失败不阻断后续块
    return run;
  }

  // 注入一次性样式
  const style = document.createElement('style');
  style.textContent = [
    '.wiki-mermaid-wrap { border: 1px solid #ddd; border-radius: 3px; margin: 9px 0; background: #fff; }',
    '.wiki-mermaid-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 26px; padding: 4px 8px; background: #f4f5f7; border-bottom: 1px solid #ddd; font-size: 12px; }',
    '.wiki-mermaid-badge { color: #6b778c; font-weight: 600; }',
    '.wiki-mermaid-toggle, .wiki-mermaid-copy { cursor: pointer; background: none; border: none; padding: 0; color: #0052cc; font-size: 12px; }',
    '.wiki-mermaid-copy:disabled { cursor: default; color: #6b778c; }',
    '.wiki-mermaid-tools { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px; min-width: 0; margin-left: auto; }',
    '.wiki-mermaid-tools button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 26px; height: 24px; cursor: pointer; color: #172b4d; background: #fff; border: 1px solid #dfe1e6; border-radius: 3px; font-size: 12px; line-height: 20px; }',
    '.wiki-mermaid-tools button:hover { background: #ebecf0; }',
    '.wiki-mermaid-tools button:disabled { cursor: default; color: #a5adba; background: #f4f5f7; }',
    '.wiki-mermaid-tools .wiki-mermaid-collapse-toggle { min-width: 52px; }',
    '.wiki-mermaid-tools .wiki-mermaid-pan-toggle { min-width: 52px; }',
    '.wiki-mermaid-tools .wiki-mermaid-fullscreen-toggle { min-width: 52px; }',
    '.wiki-mermaid-tools .wiki-mermaid-pan-toggle:not(:disabled)[aria-pressed="true"] { color: #0052cc; background: #deebff; border-color: #4c9aff; }',
    '.wiki-mermaid-tools .wiki-mermaid-zoom-level { min-width: 48px; }',
    '.wiki-mermaid-tools .wiki-mermaid-fit { min-width: 70px; }',
    '.wiki-mermaid-svg { padding: ' + DIAGRAM_PADDING + 'px; overflow: auto; }',
    '.wiki-mermaid-svg > svg { display: block; max-width: none !important; flex: none; }',
    '.wiki-mermaid-svg.wiki-mermaid-pan-enabled:not(.wiki-mermaid-collapsed) { box-sizing: border-box; height: var(--wiki-mermaid-pan-viewport-height); max-height: max(' + COLLAPSED_HEIGHT + 'px, calc(100vh - ' + PAN_VIEWPORT_RESERVED_HEIGHT + 'px)); padding: calc(' + DIAGRAM_PADDING + 'px + var(--wiki-mermaid-pan-space-y, 0px)) calc(' + DIAGRAM_PADDING + 'px + var(--wiki-mermaid-pan-space-x, 0px)); }',
    '.wiki-mermaid-svg.wiki-mermaid-pannable.wiki-mermaid-pan-enabled { cursor: grab; touch-action: none; }',
    '.wiki-mermaid-svg.wiki-mermaid-dragging { cursor: grabbing; user-select: none; }',
    '.wiki-mermaid-svg.wiki-mermaid-collapsed { max-height: ' + COLLAPSED_HEIGHT + 'px; overflow-y: hidden; position: relative; }',
    '.wiki-mermaid-svg.wiki-mermaid-collapsed::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 36px; background: linear-gradient(rgba(255,255,255,0), #fff); pointer-events: none; }',
    '.wiki-mermaid-expand { display: flex; justify-content: center; padding: 3px 8px; border-top: 1px solid #eee; background: #fafbfc; }',
    '.wiki-mermaid-expand button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; background: none; border: none; padding: 2px; color: #0052cc; font-size: 12px; }',
    '.wiki-mermaid-tool-icon { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }',
    'html.wiki-mermaid-page-fullscreen-open, body.wiki-mermaid-page-fullscreen-open { overflow: hidden !important; }',
    '.wiki-mermaid-wrap.wiki-mermaid-page-fullscreen { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; margin: 0; border: none; border-radius: 0; background: #fff; }',
    '.wiki-mermaid-wrap.wiki-mermaid-page-fullscreen .wiki-mermaid-svg { flex: 1; min-width: 0; min-height: 0; max-height: none !important; }',
    '.wiki-mermaid-wrap.wiki-mermaid-page-fullscreen .wiki-mermaid-source { flex: 1; min-height: 0; overflow: auto; }',
    '.wiki-mermaid-wrap.wiki-mermaid-page-fullscreen .wiki-mermaid-collapse-toggle, .wiki-mermaid-wrap.wiki-mermaid-page-fullscreen .wiki-mermaid-expand { display: none !important; }',
    '.wiki-mermaid-wrap:not(.wiki-mermaid-off) .code.panel { margin: 0; border: none; }',
    '.wiki-mermaid-source-plain { box-sizing: border-box; width: 100%; margin: 0; padding: 12px; overflow: auto; color: #172b4d; background: #f7f8f9; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; white-space: pre; }',
    '[' + HOST_HIDDEN_ATTR + '="true"] { display: none !important; }',
    '.wiki-mermaid-wrap.wiki-mermaid-off { display: none !important; }',
    '.wiki-mermaid-error { color: #bf2600; background: #ffebe6; border: 1px solid #ffbdad; border-radius: 3px; padding: 4px 8px; margin: 4px 0; font-size: 12px; }'
  ].join('\n');
  document.head.appendChild(style);

  // 工具按钮保留文字，并使用同一套线性图标提高状态辨识度
  const TOOL_ICONS = {
    pan: '<svg class="wiki-mermaid-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1v14M1 8h14M8 1 5.5 3.5M8 1l2.5 2.5M8 15l-2.5-2.5M8 15l2.5-2.5M1 8l2.5-2.5M1 8l2.5 2.5M15 8l-2.5-2.5M15 8l-2.5 2.5"/></svg>',
    expand: '<svg class="wiki-mermaid-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3 6 5 5 5-5"/></svg>',
    collapse: '<svg class="wiki-mermaid-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3 10 5-5 5 5"/></svg>',
    fullscreen: '<svg class="wiki-mermaid-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 2H2v4M10 2h4v4M2 10v4h4M14 10v4h-4"/></svg>',
    exitFullscreen: '<svg class="wiki-mermaid-tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4"/></svg>'
  };

  function setToolButtonContent(button, icon, label) {
    button.innerHTML = TOOL_ICONS[icon] + '<span>' + label + '</span>';
  }

  // 从代码块提取源码文本；Confluence Server 的 SyntaxHighlighter 转换前后状态均支持。
  function extractSource(panel) {
    // Atlassian Cloud 使用的 Design System 代码块以 code 元素承载源码。
    if (panel.matches('[data-ds--code--code-block]')) {
      const code = panel.querySelector('code');
      return code ? code.textContent : null;
    }

    // Atlassian Live Doc 最终将代码块渲染为 CodeMirror；行号位于同级 gutters，必须只读取 cm-line。
    if (panel.matches('[data-prosemirror-node-name="codeBlock"]')) {
      const codeLines = panel.querySelectorAll('.cm-content .cm-line');
      if (codeLines.length) {
        return Array.from(codeLines).map(function (line) { return line.textContent; }).join('\n');
      }

      // 部分私有部署仍在 ProseMirror 节点内使用 pre/code，保留原有通用结构兼容。
      const nestedPre = panel.querySelector('pre');
      return nestedPre ? nestedPre.textContent : null;
    }

    // 自定义站点可能直接使用标准 pre/code 结构，pre.textContent 可保留源码换行。
    if (panel.matches('pre')) return panel.textContent;

    // 状态 1：尚未转换，pre 原样保留换行
    const pre = panel.querySelector('pre.syntaxhighlighter-pre');
    if (pre) return pre.textContent;

    // 状态 2：已转换为表格，按 .line 逐行重建换行
    const lines = panel.querySelectorAll('div.syntaxhighlighter td.code .line');
    if (lines.length) return Array.from(lines).map(function (l) { return l.textContent; }).join('\n');

    return null;
  }

  // SyntaxHighlighter 会把缩进空格渲染成 &nbsp;（U+00A0），mermaid 解析器不认，必须还原
  function normalize(src) {
    return src.replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n');
  }

  // 优先使用现代剪贴板 API；页面策略不允许时回退到浏览器复制命令。
  async function copySourceText(source) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(source);
        return;
      } catch (e) {
        console.info(logPrefix + ' 剪贴板 API 不可用，尝试兼容复制');
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = source;
    textarea.readOnly = true;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();

    let copied = false;
    try {
      copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    } finally {
      textarea.remove();
    }
    if (!copied) throw new Error('浏览器拒绝写入剪贴板');
  }

  // 取首个有效行：跳过空行、%% 开头的 mermaid 指令/注释行，以及起始 YAML frontmatter（--- 包裹的 title/config 块）
  function firstMeaningfulLine(src) {
    const lines = src.split('\n');
    let i = 0;

    while (i < lines.length && !lines[i].trim()) i++;

    // frontmatter 必须闭合才跳过，未闭合的 --- 按普通内容处理
    if (i < lines.length && lines[i].trim() === '---') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '---') j++;
      if (j < lines.length) i = j + 1;
    }

    for (; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t.indexOf('%%') === 0) continue;
      return t;
    }
    return '';
  }

  // 代码宏标题包含 mermaid 时视为显式声明，跳过首行识别直接渲染
  function titleOptIn(panel) {
    const header = panel.querySelector('.codeHeader');
    return !!header && /mermaid/i.test(header.textContent || '');
  }

  function showError(panel, err) {
    const tip = document.createElement('div');
    tip.className = 'wiki-mermaid-error';
    tip.textContent = 'Mermaid 渲染失败：' + String(err && err.message || err).slice(0, 200);
    panel.insertAdjacentElement('beforebegin', tip);
  }

  // 从 SVG 的 viewBox 读取 Mermaid 画布原始尺寸；缺少 viewBox 时再回退到宽高属性或实际尺寸
  function getSvgNaturalSize(svg) {
    const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
      return { width: viewBox[2], height: viewBox[3] };
    }

    const attrWidth = parseFloat(svg.getAttribute('width'));
    const attrHeight = parseFloat(svg.getAttribute('height'));
    if (Number.isFinite(attrWidth) && attrWidth > 0 && Number.isFinite(attrHeight) && attrHeight > 0) {
      return { width: attrWidth, height: attrHeight };
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };

    return null;
  }

  function updatePannable(item) {
    const canPanX = item.box.scrollWidth > item.box.clientWidth + 1;
    const canPanY = !item.box.classList.contains('wiki-mermaid-collapsed') && item.box.scrollHeight > item.box.clientHeight + 1;
    const canPan = canPanX || canPanY;
    item.box.classList.toggle('wiki-mermaid-pannable', canPan);
  }

  // Wiki 侧栏、分栏和窗口尺寸变化都会改变图形可视宽度，需要即时刷新是否可拖动
  function observePannableSize(item) {
    const refresh = function () {
      refreshPanSpace(item);
      updatePannable(item);
    };
    if (typeof ResizeObserver !== 'undefined') {
      item.resizeObserver = new ResizeObserver(refresh);
      item.resizeObserver.observe(item.box);
      return;
    }

    window.addEventListener('resize', refresh);
  }

  // 四周各增加当前视口 50% 的可拖动留白，使任意边缘都能移动到视口中央附近
  function refreshPanSpace(item) {
    if (!item.panEnabled) return;
    const nextX = item.box.clientWidth * PAN_EDGE_SPACE_RATIO;
    const nextY = item.box.clientHeight * PAN_EDGE_SPACE_RATIO;
    const deltaX = nextX - item.panSpaceX;
    const deltaY = nextY - item.panSpaceY;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

    item.panSpaceX = nextX;
    item.panSpaceY = nextY;
    item.box.style.setProperty('--wiki-mermaid-pan-viewport-height', item.box.clientHeight + 'px');
    item.box.style.setProperty('--wiki-mermaid-pan-space-x', nextX + 'px');
    item.box.style.setProperty('--wiki-mermaid-pan-space-y', nextY + 'px');
    item.box.scrollLeft += deltaX;
    item.box.scrollTop += deltaY;
  }

  function clearPanSpace(item) {
    const nextLeft = item.box.scrollLeft - item.panSpaceX;
    const nextTop = item.box.scrollTop - item.panSpaceY;
    item.panSpaceX = 0;
    item.panSpaceY = 0;
    item.box.style.removeProperty('--wiki-mermaid-pan-viewport-height');
    item.box.style.removeProperty('--wiki-mermaid-pan-space-x');
    item.box.style.removeProperty('--wiki-mermaid-pan-space-y');
    item.box.scrollLeft = Math.max(0, nextLeft);
    item.box.scrollTop = Math.max(0, nextTop);
  }

  // 默认保留浏览器的文字选择行为；只有显式启用拖动工具后才接管指针移动
  function setPanEnabled(item, enabled) {
    if (enabled && item.panToggle.disabled) return;
    if (!enabled && item.cancelPanGesture) item.cancelPanGesture();
    item.panEnabled = enabled;
    if (enabled) {
      item.box.classList.add('wiki-mermaid-pan-enabled');
      refreshPanSpace(item);
    } else {
      clearPanSpace(item);
      item.box.classList.remove('wiki-mermaid-pan-enabled');
    }
    item.panToggle.setAttribute('aria-pressed', String(enabled));
    item.panToggle.setAttribute('aria-label', enabled ? '退出拖动工具' : '启用拖动工具');
    item.panToggle.title = enabled ? '退出拖动模式（Esc）；滚轮可缩放图形' : '启用拖动模式（默认可选择文字）';
    updatePannable(item);
  }

  // 收起状态作为稳定预览态，展开后再按当前缩放边界恢复各工具
  function refreshToolAvailability(item) {
    if (!item.panToggle) return;
    const collapsed = item.box.classList.contains('wiki-mermaid-collapsed');

    if (collapsed && item.panEnabled) setPanEnabled(item, false);
    item.panToggle.disabled = collapsed;
    item.zoomOut.disabled = collapsed || item.scale <= MIN_ZOOM;
    item.zoomLevel.disabled = collapsed;
    item.zoomIn.disabled = collapsed || item.scale >= MAX_ZOOM;
    item.fit.disabled = collapsed;

    if (collapsed) {
      item.panToggle.setAttribute('aria-label', '展开图形后可使用拖动工具');
      item.panToggle.title = '展开图形后可上下左右拖动';
      item.zoomOut.setAttribute('aria-label', '展开图形后可缩小');
      item.zoomOut.title = '展开图形后可缩小';
      item.zoomLevel.setAttribute('aria-label', '展开图形后可恢复 100%');
      item.zoomLevel.title = '展开图形后可恢复 100%';
      item.zoomIn.setAttribute('aria-label', '展开图形后可放大');
      item.zoomIn.title = '展开图形后可放大';
      item.fit.setAttribute('aria-label', '展开图形后可适应宽度');
      item.fit.title = '展开图形后可适应宽度';
      return;
    }

    item.panToggle.setAttribute('aria-label', item.panEnabled ? '退出拖动工具' : '启用拖动工具');
    item.panToggle.title = item.panEnabled ? '退出拖动模式（Esc）；滚轮可缩放图形' : '启用拖动模式（默认可选择文字）';
    item.zoomOut.setAttribute('aria-label', '缩小图形');
    item.zoomOut.title = '缩小';
    item.zoomLevel.setAttribute('aria-label', '当前缩放 ' + formatZoomPercent(item.scale) + '，点击恢复 100%');
    item.zoomLevel.title = '恢复 100%';
    item.zoomIn.setAttribute('aria-label', '放大图形');
    item.zoomIn.title = '放大';
    item.fit.setAttribute('aria-label', '适应当前内容宽度');
    item.fit.title = '缩放到当前内容宽度';
  }

  // 折叠栏只为初始大图创建；缩放后按当前高度决定是否有效，避免小图放大时界面突然新增控件
  function canCollapseNow(item) {
    if (!item.footer) return false;
    const contentHeight = item.naturalSize
      ? item.naturalSize.height * item.scale + DIAGRAM_PADDING * 2
      : item.initialHeight;
    return contentHeight > COLLAPSED_HEIGHT;
  }

  function graphViewActive(item) {
    return !item.wrap.classList.contains('wiki-mermaid-off') &&
      !sourcePanelVisible(item) && item.box.style.display !== 'none';
  }

  function refreshFullscreenControl(item) {
    if (!item.fullscreenToggle) return;
    const active = item.pageFullscreen;
    item.fullscreenToggle.style.display = active || graphViewActive(item) ? '' : 'none';
    setToolButtonContent(item.fullscreenToggle, active ? 'exitFullscreen' : 'fullscreen', active ? '退出全屏' : '全屏');
    item.fullscreenToggle.setAttribute('aria-label', active ? '退出网页全屏查看' : '网页全屏查看图形');
    item.fullscreenToggle.title = active ? '退出网页全屏查看' : '覆盖当前网页查看图形';
  }

  // collapseRequested 保存用户或插件的收起意图；最终是否收起由当前高度和视图状态共同派生
  function refreshCollapseState(item) {
    if (!item.footer) {
      item.collapseToggle.style.display = 'none';
      updatePannable(item);
      refreshToolAvailability(item);
      refreshFullscreenControl(item);
      return;
    }

    const available = canCollapseNow(item);
    const fullscreenActive = item.pageFullscreen;
    const effectiveCollapsed = available && item.collapseRequested && !fullscreenActive;
    const wasCollapsed = item.box.classList.contains('wiki-mermaid-collapsed');

    item.box.classList.toggle('wiki-mermaid-collapsed', effectiveCollapsed);
    const collapseLabel = effectiveCollapsed ? '展开' : '收起';
    const collapseTitle = effectiveCollapsed ? '展开图形' : '收起图形';
    setToolButtonContent(item.expandBtn, effectiveCollapsed ? 'expand' : 'collapse', collapseLabel);
    item.expandBtn.setAttribute('aria-label', collapseTitle);
    item.expandBtn.title = collapseTitle;
    const collapseControlsVisible = available && graphViewActive(item) && !fullscreenActive;
    item.footer.style.display = collapseControlsVisible ? '' : 'none';
    item.collapseToggle.style.display = collapseControlsVisible ? '' : 'none';
    setToolButtonContent(item.collapseToggle, effectiveCollapsed ? 'expand' : 'collapse', collapseLabel);
    item.collapseToggle.setAttribute('aria-label', collapseTitle);
    item.collapseToggle.title = collapseTitle;

    // 从完整展示重新进入折叠态时回到图形顶部，避免缩放锚点留下不可见的纵向偏移
    if (effectiveCollapsed && !wasCollapsed) item.box.scrollTop = 0;
    updatePannable(item);
    refreshToolAvailability(item);
    refreshFullscreenControl(item);
  }

  function formatZoomPercent(scale) {
    return Number((scale * 100).toPrecision(3)) + '%';
  }

  // 按指定锚点缩放，并保持锚点在视口中的相对位置不跳动；适应宽度可突破手动缩放下限
  function setZoom(item, scale, anchorX, anchorY, allowBelowMinimum) {
    if (!item.svg || !item.naturalSize) return;

    // 适应宽度低于 5% 后，继续缩小时保持当前比例，首次放大回到手动缩放范围
    const belowMinimumZoomOut = !allowBelowMinimum && item.scale < MIN_ZOOM && scale < item.scale;
    const minimum = allowBelowMinimum ? Math.min(MIN_ZOOM, scale) : (belowMinimumZoomOut ? item.scale : MIN_ZOOM);
    const next = Math.min(MAX_ZOOM, Math.max(minimum, scale));
    const previous = item.scale;
    const x = Number.isFinite(anchorX) ? anchorX : item.box.clientWidth / 2;
    const y = Number.isFinite(anchorY) ? anchorY : item.box.clientHeight / 2;
    const oldScrollLeft = item.box.scrollLeft;
    const oldScrollTop = item.box.scrollTop;
    const paddingX = DIAGRAM_PADDING + (item.panEnabled ? item.panSpaceX : 0);
    const paddingY = DIAGRAM_PADDING + (item.panEnabled ? item.panSpaceY : 0);

    item.scale = next;
    item.svg.style.width = (item.naturalSize.width * next) + 'px';
    item.svg.style.height = (item.naturalSize.height * next) + 'px';
    const zoomText = formatZoomPercent(next);
    item.zoomLevel.textContent = zoomText;
    item.zoomLevel.setAttribute('aria-label', '当前缩放 ' + zoomText + '，点击恢复 100%');

    if (previous > 0 && previous !== next) {
      const ratio = next / previous;
      item.box.scrollLeft = (oldScrollLeft + x - paddingX) * ratio + paddingX - x;
      if (!item.box.classList.contains('wiki-mermaid-collapsed')) {
        item.box.scrollTop = (oldScrollTop + y - paddingY) * ratio + paddingY - y;
      }
    }

    refreshCollapseState(item);
  }

  function fitWidth(item) {
    if (!item.naturalSize) return;
    if (item.box.clientWidth <= DIAGRAM_PADDING * 2) return;
    const availableWidth = Math.max(1, item.box.clientWidth - DIAGRAM_PADDING * 2);
    setZoom(item, Math.min(1, availableWidth / item.naturalSize.width), 0, 0, true);
    item.box.scrollLeft = 0;
  }

  // 拖动工具启用后接管鼠标或触控移动；只有发生实际位移时才拦截点击，避免影响 SVG 内链接
  function bindPanAndWheelZoom(item) {
    let drag = null;
    let cancelledPointerId = null;
    let blockClick = false;

    item.box.addEventListener('pointerdown', function (e) {
      if (drag || cancelledPointerId !== null || !item.panEnabled || e.button !== 0 || !item.box.classList.contains('wiki-mermaid-pannable')) return;
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, left: item.box.scrollLeft, top: item.box.scrollTop, moved: false };
      item.box.setPointerCapture(e.pointerId);
      item.box.classList.add('wiki-mermaid-dragging');
    });

    item.box.addEventListener('pointermove', function (e) {
      if (!drag || drag.pointerId !== e.pointerId) return;
      const deltaX = e.clientX - drag.x;
      const deltaY = e.clientY - drag.y;
      if (!drag.moved && Math.abs(deltaX) + Math.abs(deltaY) < 4) return;

      drag.moved = true;
      item.box.scrollLeft = drag.left - deltaX;
      if (!item.box.classList.contains('wiki-mermaid-collapsed')) item.box.scrollTop = drag.top - deltaY;
      e.preventDefault();
    });

    // Esc、收起等状态切换需要立即停止位移；保留捕获到 pointerup，以继续拦截拖动产生的点击
    item.cancelPanGesture = function () {
      if (!drag) return;
      cancelledPointerId = drag.pointerId;
      blockClick = drag.moved;
      drag = null;
      item.box.classList.remove('wiki-mermaid-dragging');
    };

    function stopDragging(e) {
      let moved = false;
      if (drag && drag.pointerId === e.pointerId) {
        moved = drag.moved;
        drag = null;
      } else if (cancelledPointerId === e.pointerId) {
        moved = blockClick;
        cancelledPointerId = null;
      } else {
        return;
      }

      blockClick = e.type === 'pointerup' && moved;
      item.box.classList.remove('wiki-mermaid-dragging');
      if (item.box.hasPointerCapture(e.pointerId)) item.box.releasePointerCapture(e.pointerId);
      if (blockClick) setTimeout(function () { blockClick = false; }, 0);
    }

    item.box.addEventListener('pointerup', stopDragging);
    item.box.addEventListener('pointercancel', stopDragging);
    item.box.addEventListener('lostpointercapture', function (e) {
      if (drag && drag.pointerId === e.pointerId) drag = null;
      if (cancelledPointerId === e.pointerId) {
        cancelledPointerId = null;
        blockClick = false;
      }
      item.box.classList.remove('wiki-mermaid-dragging');
    });
    item.box.addEventListener('click', function (e) {
      if (!blockClick) return;
      blockClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // 只有拖动模式接管滚轮缩放；默认模式完全保留浏览器的页面滚动和整页缩放行为
    item.box.addEventListener('wheel', function (e) {
      if (!item.panEnabled || e.ctrlKey || item.box.classList.contains('wiki-mermaid-collapsed')) return;
      e.preventDefault();
      const rect = item.box.getBoundingClientRect();
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      setZoom(item, item.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
  }

  // 保存折叠意图并刷新派生状态；当前缩放高度不足时意图保留但不显示无效折叠栏
  function setCollapsed(item, collapsed) {
    // 网页全屏是临时查看层，期间始终完整展示，退出后统一恢复进入前快照
    if (item.pageFullscreen) {
      item.collapseRequested = false;
      refreshCollapseState(item);
      return;
    }

    item.collapseRequested = collapsed;
    refreshCollapseState(item);
  }

  function enterPageFullscreen(item) {
    if (pageFullscreenItem && pageFullscreenItem !== item) exitPageFullscreen(pageFullscreenItem);

    item.fullscreenRestoreState = {
      scale: item.scale,
      scrollLeft: item.box.scrollLeft,
      scrollTop: item.box.scrollTop,
      panEnabled: item.panEnabled,
      collapseRequested: item.collapseRequested,
      sourceVisible: sourcePanelVisible(item),
      boxDisplay: item.box.style.display,
      toggleText: item.toggle.textContent
    };
    item.fullscreenPlaceholder = document.createComment('wiki-mermaid-page-fullscreen');
    item.wrap.parentNode.insertBefore(item.fullscreenPlaceholder, item.wrap);
    document.body.appendChild(item.wrap);

    item.pageFullscreen = true;
    pageFullscreenItem = item;
    item.wrap.classList.add('wiki-mermaid-page-fullscreen');
    document.documentElement.classList.add('wiki-mermaid-page-fullscreen-open');
    document.body.classList.add('wiki-mermaid-page-fullscreen-open');
    item.collapseRequested = false;
    refreshCollapseState(item);
    item.fullscreenToggle.focus();
    window.requestAnimationFrame(function () {
      refreshPanSpace(item);
      updatePannable(item);
    });
  }

  function exitPageFullscreen(item) {
    if (!item.pageFullscreen) return;

    const restoreState = item.fullscreenRestoreState;
    if (item.panEnabled) setPanEnabled(item, false);
    else if (item.cancelPanGesture) item.cancelPanGesture();
    item.pageFullscreen = false;
    item.wrap.classList.remove('wiki-mermaid-page-fullscreen');
    if (item.fullscreenPlaceholder && item.fullscreenPlaceholder.parentNode) {
      item.fullscreenPlaceholder.parentNode.insertBefore(item.wrap, item.fullscreenPlaceholder);
      item.fullscreenPlaceholder.remove();
    } else if (item.hostPanel.isConnected && item.hostPanel.parentNode) {
      // Live Doc 重渲染可能移除占位节点，退出全屏时回退到原代码块之前
      item.hostPanel.parentNode.insertBefore(item.wrap, item.hostPanel);
    } else {
      item.wrap.remove();
    }
    item.fullscreenPlaceholder = null;

    if (pageFullscreenItem === item) pageFullscreenItem = null;
    document.documentElement.classList.remove('wiki-mermaid-page-fullscreen-open');
    document.body.classList.remove('wiki-mermaid-page-fullscreen-open');
    item.fullscreenRestoreState = null;

    if (restoreState) {
      setSourcePanelVisible(item, restoreState.sourceVisible);
      item.box.style.display = restoreState.boxDisplay;
      item.toggle.textContent = restoreState.toggleText;
      setZoom(item, restoreState.scale, 0, 0, true);
      item.collapseRequested = restoreState.collapseRequested;
      refreshCollapseState(item);
      if (restoreState.panEnabled) setPanEnabled(item, true);
      item.box.scrollLeft = restoreState.scrollLeft;
      item.box.scrollTop = restoreState.scrollTop;
    } else {
      setCollapsed(item, false);
    }

    item.fullscreenToggle.focus();
    window.requestAnimationFrame(function () {
      refreshPanSpace(item);
      if (restoreState) {
        item.box.scrollLeft = restoreState.scrollLeft;
        item.box.scrollTop = restoreState.scrollTop;
      }
      updatePannable(item);
    });
  }

  function toggleFullscreen(item) {
    if (item.pageFullscreen) exitPageFullscreen(item);
    else enterPageFullscreen(item);
  }

  // 网页全屏覆盖当前页面内容区，Esc 只退出该查看层，不触发浏览器全屏
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !pageFullscreenItem) return;
    e.preventDefault();
    e.stopPropagation();
    exitPageFullscreen(pageFullscreenItem);
  }, true);

  // 单块启用/关闭：关闭时换回源码视图并隐藏工具条，开启时恢复图形视图
  function setItemEnabled(item, on) {
    if (!on && item.pageFullscreen) exitPageFullscreen(item);
    item.wrap.classList.toggle('wiki-mermaid-off', !on);
    if (on) {
      setHostHidden(item.hostPanel, true);
      setSourcePanelVisible(item, false);
      item.box.style.display = '';
      item.toggle.textContent = '查看源码';
    } else {
      setHostHidden(item.hostPanel, false);
      setSourcePanelVisible(item, false);
    }
    refreshCollapseState(item);
  }

  function setHostHidden(panel, hidden) {
    // 只在值发生变化时写属性，避免 MutationObserver 因插件自身写入反复触发扫描
    if (hidden) {
      if (panel.getAttribute(HOST_HIDDEN_ATTR) !== 'true') panel.setAttribute(HOST_HIDDEN_ATTR, 'true');
    } else if (panel.hasAttribute(HOST_HIDDEN_ATTR)) {
      panel.removeAttribute(HOST_HIDDEN_ATTR);
    }
  }

  function sourcePanelVisible(item) {
    return item.panel.style.getPropertyValue('display') !== 'none';
  }

  function setSourcePanelVisible(item, visible) {
    // CodeMirror 根节点带 display:flex!important，源码副本必须用同级优先级控制显隐
    item.panel.style.setProperty('display', visible ? item.sourceDisplay : 'none', 'important');
  }

  // 总开关即时生效：作用于全部已渲染块，开启时另补扫未处理块
  function applyEnabled(on) {
    rendered.forEach(function (item) { setItemEnabled(item, on); });
    if (on) scan();
  }

  function createSourcePanel(panel, source) {
    if (panel.matches('[data-prosemirror-node-name="codeBlock"]')) {
      // ProseMirror 的 data-local-id、data-node-anchor 等属性代表编辑器节点身份，不能复制到同一编辑树。
      const plainSource = document.createElement('pre');
      plainSource.className = 'wiki-mermaid-source wiki-mermaid-source-plain';
      plainSource.textContent = source;
      plainSource.style.setProperty('display', 'none', 'important');
      return plainSource;
    }

    const sourcePanel = panel.cloneNode(true);
    sourcePanel.classList.add('wiki-mermaid-source');
    sourcePanel.removeAttribute(PROCESSED_ATTR);
    sourcePanel.removeAttribute(HOST_HIDDEN_ATTR);
    sourcePanel.removeAttribute(OWNER_ATTR);

    // 原节点仍保留在页面中，副本移除 id 以避免重复标识影响 Wiki 和 Mermaid 的元素查询
    if (sourcePanel.id) sourcePanel.removeAttribute('id');
    sourcePanel.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
    sourcePanel.style.setProperty('display', 'none', 'important');
    return sourcePanel;
  }

  function refreshSourcePanel(item) {
    const structure = item.hostPanel.innerHTML;
    if (structure === item.sourceStructure) return;

    if (item.hostPanel.matches('[data-prosemirror-node-name="codeBlock"]')) {
      // CodeMirror 的光标和测量节点会改变内部结构；只读源码由已提取文本生成，无需同步编辑器 DOM。
      item.sourceStructure = structure;
      return;
    }

    // SyntaxHighlighter 可能在首次渲染后补做结构转换，同步副本以保持旧版 Wiki 源码视图外观
    const visible = sourcePanelVisible(item);
    const sourcePanel = createSourcePanel(item.hostPanel, item.source);
    item.panel.replaceWith(sourcePanel);
    item.panel = sourcePanel;
    item.sourceStructure = structure;
    setSourcePanelVisible(item, visible);
  }

  // 在原代码块前插入独立容器：不移动 Wiki 管理的节点，避免客户端重渲染覆盖插件结果；
  // 容器内含工具条、缩放控件、图形区和原代码块结构副本，点按钮在图形/源码间切换；
  // 图形高度超过 a 时追加「展开/收起」栏，超过 b 的图按 collapseLarge 设置默认折叠
  function insertRendered(panel, svg, source) {
    const sourceDisplay = panel.matches('[data-prosemirror-node-name="codeBlock"]') ? 'block' : getComputedStyle(panel).display;
    const wrap = document.createElement('div');
    wrap.className = 'wiki-mermaid-wrap';

    const bar = document.createElement('div');
    bar.className = 'wiki-mermaid-bar';
    const badge = document.createElement('span');
    badge.className = 'wiki-mermaid-badge';
    badge.textContent = 'mermaid';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'wiki-mermaid-toggle';
    toggle.textContent = '查看源码';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'wiki-mermaid-copy';
    copy.textContent = '复制源码';
    copy.setAttribute('aria-label', '复制 Mermaid 源码');
    copy.setAttribute('aria-live', 'polite');
    bar.appendChild(badge);
    bar.appendChild(toggle);
    bar.appendChild(copy);

    const toolbarTools = document.createElement('div');
    toolbarTools.className = 'wiki-mermaid-tools';
    const collapseToggle = document.createElement('button');
    collapseToggle.type = 'button';
    collapseToggle.className = 'wiki-mermaid-collapse-toggle';
    collapseToggle.style.display = 'none';
    const panToggle = document.createElement('button');
    panToggle.type = 'button';
    panToggle.className = 'wiki-mermaid-pan-toggle';
    setToolButtonContent(panToggle, 'pan', '拖动');
    panToggle.setAttribute('aria-label', '启用拖动工具');
    panToggle.setAttribute('aria-pressed', 'false');
    panToggle.title = '启用拖动模式（默认可选择文字）';
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('aria-label', '缩小图形');
    zoomOut.title = '缩小';
    const zoomLevel = document.createElement('button');
    zoomLevel.type = 'button';
    zoomLevel.className = 'wiki-mermaid-zoom-level';
    zoomLevel.textContent = '100%';
    zoomLevel.title = '恢复 100%';
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.textContent = '+';
    zoomIn.setAttribute('aria-label', '放大图形');
    zoomIn.title = '放大';
    const fit = document.createElement('button');
    fit.type = 'button';
    fit.className = 'wiki-mermaid-fit';
    fit.textContent = '适应宽度';
    fit.title = '缩放到当前内容宽度';
    const fullscreenToggle = document.createElement('button');
    fullscreenToggle.type = 'button';
    fullscreenToggle.className = 'wiki-mermaid-fullscreen-toggle';
    setToolButtonContent(fullscreenToggle, 'fullscreen', '全屏');
    fullscreenToggle.setAttribute('aria-label', '网页全屏查看图形');
    fullscreenToggle.title = '覆盖当前网页查看图形';
    toolbarTools.appendChild(collapseToggle);
    toolbarTools.appendChild(panToggle);
    toolbarTools.appendChild(zoomOut);
    toolbarTools.appendChild(zoomLevel);
    toolbarTools.appendChild(zoomIn);
    toolbarTools.appendChild(fit);
    toolbarTools.appendChild(fullscreenToggle);
    bar.appendChild(toolbarTools);

    const box = document.createElement('div');
    box.className = 'wiki-mermaid-svg';
    box.tabIndex = 0;
    box.setAttribute('aria-label', 'Mermaid 图形，默认可选择并复制文字；启用拖动工具后可拖动画布并使用滚轮缩放');
    box.innerHTML = svg;

    wrap.appendChild(bar);
    wrap.appendChild(box);

    // 源码视图使用原结构副本，保留旧版代码宏标题和 SyntaxHighlighter 外观
    const sourcePanel = createSourcePanel(panel, source);
    wrap.appendChild(sourcePanel);

    panel.insertAdjacentElement('beforebegin', wrap);
    setHostHidden(panel, true);

    const svgElement = box.querySelector('svg');
    const naturalSize = svgElement ? getSvgNaturalSize(svgElement) : null;
    const item = {
      wrap: wrap,
      panel: sourcePanel,
      hostPanel: panel,
      source: source,
      sourceStructure: panel.innerHTML,
      sourceDisplay: sourceDisplay && sourceDisplay !== 'none' ? sourceDisplay : 'block',
      box: box,
      svg: svgElement,
      naturalSize: naturalSize,
      scale: 1,
      collapseToggle: collapseToggle,
      panToggle: panToggle,
      panEnabled: false,
      panSpaceX: 0,
      panSpaceY: 0,
      cancelPanGesture: null,
      resizeObserver: null,
      zoomOut: zoomOut,
      zoomLevel: zoomLevel,
      zoomIn: zoomIn,
      fit: fit,
      fullscreenToggle: fullscreenToggle,
      fullscreenRestoreState: null,
      fullscreenPlaceholder: null,
      pageFullscreen: false,
      toggle: toggle,
      footer: null,
      expandBtn: null,
      // 是否达到默认收起阈值按 100% 高度判断，避免自动适应宽度改变原有的大图判定
      large: naturalSize ? naturalSize.height + DIAGRAM_PADDING * 2 > COLLAPSE_TRIGGER : false,
      initialHeight: 0,
      collapseRequested: false
    };
    rendered.push(item);

    if (naturalSize) {
      // 首次展示仅缩小超出内容区的图形，先给出完整宽度视图；未超宽的小图保持 100%
      fitWidth(item);
      bindPanAndWheelZoom(item);
      observePannableSize(item);
      panToggle.addEventListener('click', function () { setPanEnabled(item, !item.panEnabled); });
      wrap.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && item.panEnabled && !item.pageFullscreen) setPanEnabled(item, false);
      });
      zoomOut.addEventListener('click', function () { setZoom(item, item.scale / ZOOM_FACTOR); });
      zoomLevel.addEventListener('click', function () { setZoom(item, 1); });
      zoomIn.addEventListener('click', function () { setZoom(item, item.scale * ZOOM_FACTOR); });
      fit.addEventListener('click', function () { fitWidth(item); });
    } else {
      panToggle.style.display = 'none';
      zoomOut.style.display = 'none';
      zoomLevel.style.display = 'none';
      zoomIn.style.display = 'none';
      fit.style.display = 'none';
    }

    collapseToggle.addEventListener('click', function () {
      setCollapsed(item, !item.collapseRequested);
    });
    fullscreenToggle.addEventListener('click', function () { toggleFullscreen(item); });

    // 高度要等插入 DOM 后才能测量；隐藏容器中的块测得 0，不会误挂展开栏
    const h = box.scrollHeight;
    item.initialHeight = h;
    if (!naturalSize) item.large = h > COLLAPSE_TRIGGER;
    if (h > COLLAPSED_HEIGHT) {
      const footer = document.createElement('div');
      footer.className = 'wiki-mermaid-expand';
      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      footer.appendChild(expandBtn);
      wrap.insertBefore(footer, sourcePanel);
      item.footer = footer;
      item.expandBtn = expandBtn;

      expandBtn.addEventListener('click', function () {
        setCollapsed(item, !item.collapseRequested);
      });

      // 超过 b 的图按设置默认折叠；a<高度≤b 的图默认全高展示，仅提供手工收起
      setCollapsed(item, settings.collapseLarge && item.large);
    }

    toggle.addEventListener('click', function () {
      const showingSvg = !sourcePanelVisible(item);
      setSourcePanelVisible(item, showingSvg);
      box.style.display = showingSvg ? 'none' : '';
      toggle.textContent = showingSvg ? '查看图形' : '查看源码';
      refreshCollapseState(item);
    });

    let copyResetTimer = null;
    copy.addEventListener('click', function () {
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copy.disabled = true;
      copySourceText(source).then(function () {
        copy.textContent = '已复制';
      }, function (e) {
        copy.textContent = '复制失败';
        console.warn(logPrefix + ' 复制源码失败', e);
      }).finally(function () {
        copyResetTimer = setTimeout(function () {
          copy.textContent = '复制源码';
          copy.disabled = false;
          copyResetTimer = null;
        }, 1500);
      });
    });

    refreshFullscreenControl(item);

    return item;
  }

  async function processPanel(panel) {
    if (!settings.enabled) return; // 总开关关闭时不处理也不写状态标记，重新开启后可补扫

    // 页面可能只清除插件属性但继续复用同一节点；已有任务或图形关联时不得重复渲染
    const active = processingPanels.has(panel) || rendered.some(function (item) { return item.hostPanel === panel; });
    if (active) return;

    const processed = panel.getAttribute(PROCESSED_ATTR);
    if (processed) {
      const ownedByCurrentRun = panel.getAttribute(OWNER_ATTR) === RUN;

      // Live Doc 可能克隆带状态的旧节点；仅清理由当前实例留下且已经没有任务或图形关联的状态
      if (ownedByCurrentRun && (processed === 'pending' || processed === 'done')) {
        panel.removeAttribute(PROCESSED_ATTR);
        panel.removeAttribute(OWNER_ATTR);
        setHostHidden(panel, false);
      } else {
        return;
      }
    }

    const raw = extractSource(panel);
    if (raw === null) return; // DOM 还没就绪，等下一轮扫描再处理

    const src = normalize(raw).trim();
    if (!src) {
      panel.setAttribute(PROCESSED_ATTR, 'skip');
      return;
    }

    const optIn = titleOptIn(panel);
    if (!optIn && !DIAGRAM_RE.test(firstMeaningfulLine(src))) {
      panel.setAttribute(PROCESSED_ATTR, 'skip');
      return;
    }

    // 先占位，防止 MutationObserver 触发的并发扫描重复处理
    panel.setAttribute(PROCESSED_ATTR, 'pending');
    panel.setAttribute(OWNER_ATTR, RUN);
    processingPanels.add(panel);

    const id = 'wiki-mermaid-' + RUN + '-' + (++seq);

    // 语法预校验 + 渲染作为一个原子任务进入串行链；
    // 自动识别的块解析失败时静默跳过，避免误伤碰巧以关键字开头的普通文本
    let parseErr = null;
    let out = null;
    try {
      out = await mermaidSerialized(async function () {
        const parseOk = await M.parse(src).then(function () { return true; }, function (e) { parseErr = e; return false; });
        if (!parseOk) return null;
        return M.render(id, src);
      });
    } catch (e) {
      processingPanels.delete(panel);
      // render 失败时 mermaid 会在 body 残留临时节点，清理掉
      const tmp = document.getElementById('d' + id);
      if (tmp) tmp.remove();
      panel.setAttribute(PROCESSED_ATTR, 'error');
      if (optIn) showError(panel, e);
      console.warn(logPrefix + ' 渲染失败', e);
      return;
    }

    if (out === null) {
      processingPanels.delete(panel);
      panel.setAttribute(PROCESSED_ATTR, optIn ? 'error' : 'skip');
      if (optIn) showError(panel, parseErr);
      console.info(logPrefix + ' 语法校验未通过，跳过该代码块：' + String(parseErr && parseErr.message || parseErr).slice(0, 120));
      return;
    }

    // Mermaid 排队期间 Live Doc 可能替换节点或更新源码，过期结果不得再写回页面
    const latestRaw = panel.isConnected ? extractSource(panel) : null;
    const latestSource = latestRaw === null ? null : normalize(latestRaw).trim();
    if (!panel.isConnected || latestSource !== src) {
      processingPanels.delete(panel);
      panel.removeAttribute(PROCESSED_ATTR);
      panel.removeAttribute(OWNER_ATTR);
      if (panel.isConnected) setTimeout(scan, 0);
      return;
    }

    const item = insertRendered(panel, out.svg, src);
    panel.setAttribute(PROCESSED_ATTR, 'done');
    processingPanels.delete(panel);

    // 渲染排队期间总开关可能被关闭，落地后立即置为关闭态，避免关闭后仍冒出新图
    if (!settings.enabled) setItemEnabled(item, false);

    console.info(logPrefix + ' 渲染成功 ' + id);
  }

  function removeRenderedItem(index, restoreHost) {
    const item = rendered[index];
    if (!item) return;

    if (item.pageFullscreen) exitPageFullscreen(item);
    if (item.resizeObserver) item.resizeObserver.disconnect();
    if (item.cancelPanGesture) item.cancelPanGesture();
    item.wrap.remove();

    if (restoreHost) {
      setHostHidden(item.hostPanel, false);
      item.hostPanel.removeAttribute(PROCESSED_ATTR);
      item.hostPanel.removeAttribute(OWNER_ATTR);
    }

    rendered.splice(index, 1);
  }

  // Live Doc 会在客户端加载后重建内容树：补回被移除的插件容器，并淘汰已失效的原代码块引用
  function reconcileRendered() {
    for (let i = rendered.length - 1; i >= 0; i--) {
      const item = rendered[i];

      if (!item.hostPanel.isConnected) {
        // 临时摘下后复用同一节点也是 Live Doc 的常见更新方式，清掉状态以便重新挂载时再处理
        removeRenderedItem(i, true);
        continue;
      }

      const raw = extractSource(item.hostPanel);
      const currentSource = raw === null ? null : normalize(raw).trim();
      if (currentSource !== null && currentSource !== item.source) {
        removeRenderedItem(i, true);
        continue;
      }

      refreshSourcePanel(item);

      if (!item.pageFullscreen &&
          (item.wrap.parentNode !== item.hostPanel.parentNode || item.wrap.nextSibling !== item.hostPanel)) {
        item.hostPanel.parentNode.insertBefore(item.wrap, item.hostPanel);
      }

      // React 复用节点时可能清理未知 data 属性；恢复完整状态并保持跨实例互斥
      if (item.hostPanel.getAttribute(PROCESSED_ATTR) !== 'done') item.hostPanel.setAttribute(PROCESSED_ATTR, 'done');
      if (item.hostPanel.getAttribute(OWNER_ATTR) !== RUN) item.hostPanel.setAttribute(OWNER_ATTR, RUN);
      setHostHidden(item.hostPanel, settings.enabled);
    }
  }

  function scan() {
    reconcileRendered();

    document.querySelectorAll(CODE_BLOCK_SELECTOR).forEach(function (panel) {
      // 插件自己的源码副本和 SVG 内部节点不参与扫描
      if (panel.closest('.wiki-mermaid-wrap')) return;

      // 外层代码块已经包含源码节点时只处理外层，避免同一块被重复排队。
      if (panel.matches('[data-ds--code--code-block]') && panel.closest('div.code.panel')) return;
      if (panel.matches('[data-prosemirror-node-name="codeBlock"]') && panel.closest('div.code.panel, [data-ds--code--code-block]')) return;
      if (panel.matches('pre') && panel.closest('div.code.panel, [data-ds--code--code-block], [data-prosemirror-node-name="codeBlock"]')) return;
      processPanel(panel);
    });
  }

  function start() {
    // 首次扫描；SyntaxHighlighter 的转换和动态内容（含评论区代码块）通过 MutationObserver 增量补扫
    scan();

    let scanTimer = null;
    const observer = new MutationObserver(function (mutations) {
      // 全局 childList 保持原有动态内容兼容；文本及显隐属性只响应代码块内部变化，避免普通页面刷新触发全量扫描
      const relevant = mutations.some(function (mutation) {
        if (mutation.type === 'childList') return true;
        if (mutation.type === 'attributes') return mutation.attributeName === HOST_HIDDEN_ATTR;
        return mutation.target.parentElement && mutation.target.parentElement.closest(CODE_BLOCK_SELECTOR);
      });
      if (!relevant) return;
      if (scanTimer) return;
      scanTimer = setTimeout(function () {
        scanTimer = null;
        scan();
      }, 200);
    });
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [HOST_HIDDEN_ATTR],
      subtree: true
    });
  }

  if (syncStore) {
    // 插件形态：监听 popup 的开关变更即时生效，读到设置后再开扫
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      if ('enabled' in changes) {
        settings.enabled = changes.enabled.newValue;
        applyEnabled(settings.enabled);
        console.info(logPrefix + ' 渲染总开关: ' + (settings.enabled ? '开' : '关'));
      }
      if ('collapseLarge' in changes) {
        settings.collapseLarge = changes.collapseLarge.newValue;
        // 按各块默认态重放：只有超过 b 的图受设置影响，a<高度≤b 的图始终默认全高
        rendered.forEach(function (item) {
          if (item.footer) setCollapsed(item, settings.collapseLarge && item.large);
        });
      }
    });

    // 弹窗「全部展开/全部收缩」：即时作用于当前页所有带展开栏的图
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || msg.type !== 'wiki-mermaid-collapse-all') return;
        rendered.forEach(function (item) {
          if (item.footer) setCollapsed(item, msg.collapsed);
        });
      });
    }
    syncStore.get(DEFAULT_SETTINGS, function (v) {
      settings.enabled = v.enabled;
      settings.collapseLarge = v.collapseLarge;
      start();
    });
  } else {
    // 存储 API 不可用时直接使用默认设置
    start();
  }
})();
