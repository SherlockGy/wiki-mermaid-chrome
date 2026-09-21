// Wiki 站点配置：弹窗与后台共用地址校验、归一化和匹配规则。
(function (scope) {
  'use strict';

  const CUSTOM_SITES_KEY = 'customSites';
  const MAX_CUSTOM_SITES = 50;
  const MAX_INPUT_LENGTH = 8192;
  const SYNC_ITEM_QUOTA_BYTES = 8192;

  function trimSiteCandidate(value) {
    return value.trim()
      .replace(/^[\[\]()<>{}"'`“”‘’《》「」『』]+/u, '')
      .replace(/[\[\]()<>{}"'`“”‘’《》「」『』,.;!?，。；：！？、]+$/u, '');
  }

  function extractSiteCandidate(input) {
    if (typeof input !== 'string' || !input.trim()) {
      throw new Error('请输入 Wiki 地址');
    }

    const raw = input.trim();
    if (raw.length > MAX_INPUT_LENGTH) throw new Error('粘贴内容过长');

    // 优先截取文本中的完整 HTTP/HTTPS URL；路径、查询参数会在后续归一化时去除。
    const absoluteUrl = raw.match(/https?:\/\/[^\s<>"'`，。；：！？、）》」』\]}]+/i);
    if (absoluteUrl) return trimSiteCandidate(absoluteUrl[0]);

    // 文本中仅出现其他协议地址时保留原协议，由归一化逻辑给出明确错误。
    const unsupportedUrl = raw.match(/[a-z][a-z\d+.-]*:[^\s<>"'`，。；：！？、）》」』\]}]+/i);
    if (unsupportedUrl) return trimSiteCandidate(unsupportedUrl[0]);

    // 未带协议时，从说明文字中识别常见域名、IPv4 或 localhost 地址。
    const domainWithPath = raw.match(/(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z\d-]+\.)+[a-z\d-]+)(?::\d+)?(?:\/[^\s<>"'`]*)?/i);
    if (domainWithPath) return trimSiteCandidate(domainWithPath[0]);

    return trimSiteCandidate(raw);
  }

  function normalizeSiteInput(input) {
    const extracted = extractSiteCandidate(input);
    if (extracted.includes('*')) throw new Error('自定义地址不能包含通配符');

    // 允许直接输入域名；未写协议时按 HTTPS 处理。
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(extracted) ? extracted : 'https://' + extracted;
    let url;
    try {
      url = new URL(candidate);
    } catch (e) {
      throw new Error('地址格式不正确');
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('仅支持 HTTP 或 HTTPS 地址');
    }
    if (!url.hostname) throw new Error('地址缺少域名');
    if (url.username || url.password) throw new Error('地址不能包含用户名或密码');

    return url.origin;
  }

  function toMatchPattern(origin) {
    return normalizeSiteInput(origin) + '/*';
  }

  function isBuiltInSite(origin) {
    const url = new URL(normalizeSiteInput(origin));
    if (url.protocol !== 'https:') return false;

    return url.hostname === 'atlassian.net' ||
      url.hostname.endsWith('.atlassian.net');
  }

  function normalizeStoredSites(value) {
    if (!Array.isArray(value)) return [];

    const sites = [];
    value.forEach(function (item) {
      try {
        const origin = normalizeSiteInput(item);
        if (!sites.includes(origin) && !isBuiltInSite(origin)) sites.push(origin);
      } catch (e) {
        // 历史或手工写入的无效配置不参与脚本注册。
      }
    });
    return sites.slice(0, MAX_CUSTOM_SITES);
  }

  function assertCustomSitesStorageFits(sites) {
    // chrome.storage.sync 按“字段名 + JSON 值”的 UTF-8 字节数计算单项容量。
    const serialized = CUSTOM_SITES_KEY + JSON.stringify(sites);
    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes > SYNC_ITEM_QUOTA_BYTES) {
      throw new Error('站点配置存储空间已满，请先移除不再使用的站点');
    }
  }

  scope.WikiMermaidSites = Object.freeze({
    CUSTOM_SITES_KEY: CUSTOM_SITES_KEY,
    MAX_CUSTOM_SITES: MAX_CUSTOM_SITES,
    extractSiteCandidate: extractSiteCandidate,
    normalizeSiteInput: normalizeSiteInput,
    toMatchPattern: toMatchPattern,
    isBuiltInSite: isBuiltInSite,
    normalizeStoredSites: normalizeStoredSites,
    assertCustomSitesStorageFits: assertCustomSitesStorageFits
  });
})(globalThis);
