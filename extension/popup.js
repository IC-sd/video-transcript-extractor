/**
 * popup.js —— 面板逻辑：识别当前视频 → 触发提取 → 打开结果页
 */

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

const DEFAULTS = {
  transcriptSave: false, transcriptDir: '字幕',
  summarySave: false, summaryDir: '总结',
  alwaysAsk: true, allParts: false, withTimestamp: true,
};

async function getSettings() {
  const cur = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(cur.settings || {}) };
}

function isVideoUrl(u) {
  u = u || '';
  return /bilibili\.com\/(video|list)\//.test(u)
    || /bilibili\.com\/bangumi\/play\//.test(u)
    || /youtube\.com\/(watch|shorts\/)/.test(u);
}

function setStatus(text, cls) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

/** content script 可能没注入（例如扩展是在页面打开之后才装的），这里兜底注入 */
async function ensureInjected(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (r && r.ok) return r;
  } catch (e) { /* 未注入，继续尝试 */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (e) {
    return null;
  }
}

function cleanTitle(t) {
  return String(t || '').replace(/[_\-|]\s*哔哩哔哩.*$/, '').replace(/_哔哩哔哩_bilibili$/, '').trim();
}

function disableAll() {
  ['runTranscript', 'runAi'].forEach((id) => { const b = $(id); if (b) b.disabled = true; });
}

(async function init() {
  const s = await getSettings();
  $('allP').checked = !!s.allParts;
  $('withTs').checked = !!s.withTimestamp;
  $('translateCn').checked = !!((await chrome.storage.local.get('lastOpts')).lastOpts || {}).translateCn;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isVideoUrl(tab.url)) {
    $('vtitle').textContent = '当前页面不是 B站视频页';
    $('vmeta').innerHTML = '<span class="warn">请先打开一个 B站视频页面，再点这个图标</span>';
    disableAll();
    return;
  }

  const ping = await ensureInjected(tab.id);
  if (!ping) {
    $('vtitle').textContent = '无法连接页面';
    $('vmeta').innerHTML = '<span class="err">请刷新一下 B站页面再试</span>';
    disableAll();
    return;
  }
  $('vtitle').textContent = cleanTitle(ping.title) || ping.bvid || '已识别到视频';
  $('vmeta').textContent = ping.bvid ? `${ping.bvid} · ${tab.title ? '已就绪' : ''}` : '已就绪';

  async function run(mode) {
  const opts = { allP: $('allP').checked, withTs: $('withTs').checked, translateCn: $('translateCn').checked };
    const btnMap = { transcript: $('runTranscript'), aisum: $('runAi') };
    const btn = btnMap[mode] || btnMap.transcript;
    const all = [btnMap.transcript, btnMap.aisum].filter(Boolean);
    const label = btn.textContent;
    const busyText = { transcript: '正在提取…', aisum: '正在提取总结…' };
    all.forEach((b) => { b.disabled = true; });
    btn.innerHTML = '<span class="spinner"></span>' + (busyText[mode] || '处理中…');
    setStatus('正在读取字幕，请稍候…');

    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT', opts });
      if (!resp || !resp.ok) {
        setStatus('提取失败：' + ((resp && resp.error) || '未知错误'), 'err');
        return;
      }
      const data = resp.data;
      if (!data.ok) {
        setStatus(`没有取到字幕（${data.error || '未知原因'}）。若提示"无字幕轨道"，说明该视频 UP主没传字幕、B站也没生成 AI 字幕，只能靠语音识别。`, 'err');
        return;
      }

      setStatus(`已拿到 ${data.chars} 字，正在打开结果页…`, 'ok');
      await chrome.storage.local.set({
        lastResult: data,
        lastResultAt: Date.now(),
        lastOpts: opts,
        openTab: mode,
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });
      window.close();
    } catch (e) {
      setStatus('出错：' + (e && e.message ? e.message : e), 'err');
    } finally {
      all.forEach((b) => { b.disabled = false; });
      btn.textContent = label;
    }
  }

  $('runTranscript').addEventListener('click', () => run('transcript'));
  $('runAi').addEventListener('click', () => run('aisum'));
})();

$('openOpts').addEventListener('click', () => chrome.runtime.openOptionsPage());
