// 自定义 Wiki 站点后台：把已授权站点同步为持久化动态 content script。
importScripts('site-config.js');

const logPrefix = '[syncCustomSites 自定义Wiki站点同步]';
const CUSTOM_SCRIPT_ID = 'wiki-mermaid-custom-sites';
const sitesApi = globalThis.WikiMermaidSites;
let syncChain = Promise.resolve();

async function syncCustomSiteScripts() {
  const stored = await chrome.storage.sync.get(sitesApi.CUSTOM_SITES_KEY);
  const sites = sitesApi.normalizeStoredSites(stored[sitesApi.CUSTOM_SITES_KEY]);
  const grantedPatterns = [];

  for (const origin of sites) {
    const pattern = sitesApi.toMatchPattern(origin);
    if (await chrome.permissions.contains({ origins: [pattern] })) grantedPatterns.push(pattern);
  }

  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CUSTOM_SCRIPT_ID] });
  if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_SCRIPT_ID] });
  }

  if (grantedPatterns.length) {
    await chrome.scripting.registerContentScripts([{
      id: CUSTOM_SCRIPT_ID,
      matches: grantedPatterns,
      js: ['mermaid.min.js', 'content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  }

  console.info(logPrefix + ' 已同步 ' + grantedPatterns.length + ' 个站点');
  return { siteCount: sites.length, activeCount: grantedPatterns.length };
}

function enqueueSync() {
  const task = syncChain.then(syncCustomSiteScripts, syncCustomSiteScripts);
  syncChain = task.then(function () {}, function () {});
  return task;
}

chrome.runtime.onInstalled.addListener(function () {
  enqueueSync().catch(function (e) { console.warn(logPrefix + ' 安装后同步失败', e); });
});

chrome.runtime.onStartup.addListener(function () {
  enqueueSync().catch(function (e) { console.warn(logPrefix + ' 启动后同步失败', e); });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'sync' || !(sitesApi.CUSTOM_SITES_KEY in changes)) return;
  enqueueSync().catch(function (e) { console.warn(logPrefix + ' 配置变更后同步失败', e); });
});

chrome.permissions.onAdded.addListener(function () {
  enqueueSync().catch(function (e) { console.warn(logPrefix + ' 授权后同步失败', e); });
});

chrome.permissions.onRemoved.addListener(function () {
  enqueueSync().catch(function (e) { console.warn(logPrefix + ' 权限移除后同步失败', e); });
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'wiki-mermaid-sync-custom-sites') return;

  enqueueSync().then(function (result) {
    sendResponse({ ok: true, result: result });
  }, function (e) {
    console.warn(logPrefix + ' 手工同步失败', e);
    sendResponse({ ok: false, error: String(e && e.message || e) });
  });
  return true;
});
