// 插件弹窗：管理渲染开关、当前页操作和自定义 Wiki 站点授权。
// enabled=渲染总开关；collapseLarge=大图默认折叠。默认值须与 content.js 中 DEFAULT_SETTINGS 保持一致。
const DEFAULT_SETTINGS = { enabled: true, collapseLarge: true };
const sitesApi = globalThis.WikiMermaidSites;
const siteInput = document.getElementById('site-input');
const siteAddButton = document.getElementById('site-add-button');
const siteList = document.getElementById('site-list');
const siteStatus = document.getElementById('site-status');
const siteSaveLogPrefix = '[saveCustomSites 自定义Wiki站点保存]';
let customSites = [];
let customSitesLoaded = false;

chrome.storage.sync.get(Object.assign({}, DEFAULT_SETTINGS, { customSites: [] }), function (v) {
  if (chrome.runtime.lastError) {
    setSiteStatus('读取站点配置失败：' + chrome.runtime.lastError.message, true);
    return;
  }

  document.getElementById('enabled').checked = v.enabled;
  document.getElementById('collapseLarge').checked = v.collapseLarge;
  customSites = sitesApi.normalizeStoredSites(v[sitesApi.CUSTOM_SITES_KEY]);
  customSitesLoaded = true;
  siteInput.disabled = false;
  siteAddButton.disabled = false;
  renderCustomSites().catch(function (e) {
    setSiteStatus('显示站点配置失败：' + String(e && e.message || e), true);
  });
});

['enabled', 'collapseLarge'].forEach(function (key) {
  document.getElementById(key).addEventListener('change', function (e) {
    const patch = {};
    patch[key] = e.target.checked;
    chrome.storage.sync.set(patch);
  });
});

// 全部收缩/全部展开：向当前活动标签页的 content script 发消息，作用于本页所有带展开栏的图
function sendCollapseAll(collapsed) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs.length) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'wiki-mermaid-collapse-all', collapsed: collapsed }, function () {
      void chrome.runtime.lastError; // 非 wiki 页无接收方，吞掉报错避免控制台噪音
    });
  });
}

document.getElementById('collapse-all').addEventListener('click', function () { sendCollapseAll(true); });
document.getElementById('expand-all').addEventListener('click', function () { sendCollapseAll(false); });

function setSiteStatus(message, isError) {
  siteStatus.textContent = message;
  siteStatus.classList.toggle('error', !!isError);
}

siteInput.addEventListener('paste', function (event) {
  const pasted = event.clipboardData && event.clipboardData.getData('text');
  if (!pasted) return;

  try {
    const origin = sitesApi.normalizeSiteInput(pasted);
    event.preventDefault();
    siteInput.value = origin;
    setSiteStatus('已识别站点：' + origin);
  } catch (e) {
    // 无法识别时保留浏览器默认粘贴行为，提交时再显示具体错误。
  }
});

function syncCustomSiteScripts() {
  return chrome.runtime.sendMessage({ type: 'wiki-mermaid-sync-custom-sites' }).then(function (response) {
    if (!response || !response.ok) {
      throw new Error(response && response.error || '后台没有返回同步结果');
    }
    return response.result;
  });
}

async function saveCustomSites(sites) {
  try {
    await chrome.storage.sync.set({ customSites: sites });
  } catch (e) {
    const reason = String(e && e.message || e);
    console.warn(siteSaveLogPrefix + ' 保存失败', e);
    if (/QUOTA_BYTES|quota bytes|bytes.*quota/i.test(reason)) {
      throw new Error('站点配置存储空间已满，请先移除不再使用的站点');
    }
    throw new Error('站点配置保存失败，请稍后重试');
  }
}

async function activateCustomSite(origin) {
  const pattern = sitesApi.toMatchPattern(origin);
  const alreadyAdded = customSites.includes(origin);
  const nextSites = alreadyAdded ? customSites : customSites.concat(origin);

  // 容量校验保持同步执行，避免明知无法保存时仍向用户申请站点权限。
  if (!alreadyAdded) sitesApi.assertCustomSitesStorageFits(nextSites);

  // 权限请求必须直接由用户点击触发，因此调用前不执行异步操作。
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    setSiteStatus('未获得该站点权限，地址没有启用', true);
    return;
  }

  if (!alreadyAdded) {
    await saveCustomSites(nextSites);
    // 仅在持久化成功后更新内存，避免失败后弹窗显示未保存的站点。
    customSites = nextSites;
  }

  await syncCustomSiteScripts();
  await renderCustomSites();
  siteInput.value = '';
  setSiteStatus('已启用 ' + origin + '，请刷新对应 Wiki 页面');
}

async function removeCustomSite(origin) {
  const nextSites = customSites.filter(function (item) { return item !== origin; });
  await saveCustomSites(nextSites);
  customSites = nextSites;

  let syncError = null;
  try {
    await syncCustomSiteScripts();
  } catch (e) {
    syncError = e;
  }

  // 删除配置时一并收回该站点权限，确保插件不再访问该站点。
  await chrome.permissions.remove({ origins: [sitesApi.toMatchPattern(origin)] });
  await renderCustomSites();
  if (syncError) throw syncError;
  setSiteStatus('已移除 ' + origin);
}

async function renderCustomSites() {
  siteList.replaceChildren();
  if (!customSites.length) {
    const empty = document.createElement('div');
    empty.className = 'site-empty';
    empty.textContent = '暂未添加自定义站点';
    siteList.appendChild(empty);
    return;
  }

  const permissionStates = await Promise.all(customSites.map(function (origin) {
    return chrome.permissions.contains({ origins: [sitesApi.toMatchPattern(origin)] });
  }));

  customSites.forEach(function (origin, index) {
    const row = document.createElement('div');
    row.className = 'site-item';

    const label = document.createElement('span');
    label.className = 'site-origin';
    label.textContent = origin;
    label.title = origin;
    row.appendChild(label);

    if (!permissionStates[index]) {
      const permission = document.createElement('span');
      permission.className = 'site-permission';
      permission.textContent = '待授权';
      row.appendChild(permission);

      const authorizeButton = document.createElement('button');
      authorizeButton.type = 'button';
      authorizeButton.textContent = '授权';
      authorizeButton.addEventListener('click', function () {
        authorizeButton.disabled = true;
        activateCustomSite(origin).catch(function (e) {
          setSiteStatus('授权失败：' + String(e && e.message || e), true);
        }).finally(function () {
          authorizeButton.disabled = false;
        });
      });
      row.appendChild(authorizeButton);
    }

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = '移除';
    removeButton.addEventListener('click', function () {
      removeButton.disabled = true;
      removeCustomSite(origin).catch(function (e) {
        setSiteStatus('移除失败：' + String(e && e.message || e), true);
      }).finally(function () {
        removeButton.disabled = false;
      });
    });
    row.appendChild(removeButton);
    siteList.appendChild(row);
  });
}

document.getElementById('site-add-form').addEventListener('submit', function (event) {
  event.preventDefault();
  setSiteStatus('');

  if (!customSitesLoaded) {
    setSiteStatus('站点配置仍在加载，请稍后重试', true);
    return;
  }

  let origin;
  try {
    origin = sitesApi.normalizeSiteInput(siteInput.value);
  } catch (e) {
    setSiteStatus(String(e && e.message || e), true);
    return;
  }

  if (sitesApi.isBuiltInSite(origin)) {
    setSiteStatus('该站点已内置支持，无需重复添加');
    return;
  }
  if (!customSites.includes(origin) && customSites.length >= sitesApi.MAX_CUSTOM_SITES) {
    setSiteStatus('最多添加 ' + sitesApi.MAX_CUSTOM_SITES + ' 个自定义站点', true);
    return;
  }

  siteAddButton.disabled = true;
  activateCustomSite(origin).catch(function (e) {
    setSiteStatus('添加失败：' + String(e && e.message || e), true);
  }).finally(function () {
    siteAddButton.disabled = false;
  });
});
