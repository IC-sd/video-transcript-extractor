/**
 * result.js —— 结果页：渲染转录与总结，两者可分别设置保存方式与是否保存。
 *
 * 三种保存方式（由设置页决定，此处也支持临时「另存为」）：
 *   dir  —— 写入用户授权的固定文件夹（唯一能写绝对路径的方式，不弹对话框）
 *   ask  —— 每次弹系统保存对话框
 *   sub  —— 静默存到「浏览器下载目录 / 子目录」
 */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  transcriptSave: false, transcriptMode: 'sub', transcriptDir: '字幕',
  aiSave: false, aiMode: 'sub', aiDir: '总结',
  allParts: false, withTimestamp: true, termFixes: '',
};

let DATA = null;
let POLISH = null;
let AISUM = null;
let S = { ...DEFAULTS };
let curTab = 'transcript';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** 极简 Markdown 渲染（格式由本扩展自己产出，不需要完整解析器） */
function renderMd(md) {
  const out = [];
  let inTable = false, inUl = false, inOl = false;
  const closeList = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  const closeTable = () => { if (inTable) { out.push('</table>'); inTable = false; } };

  for (const raw of String(md).split('\n')) {
    const t = raw.replace(/\r$/, '').trim();

    if (/^\|.*\|$/.test(t)) {
      if (/^\|[\s\-:|]+\|$/.test(t)) continue;
      const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (!inTable) {
        closeList();
        out.push('<table>');
        out.push('<tr>' + cells.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>');
        inTable = true;
      } else {
        out.push('<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      }
      continue;
    }
    closeTable();

    if (!t) { closeList(); continue; }
    if (/^---+$/.test(t)) { closeList(); out.push('<hr>'); continue; }

    let m;
    if ((m = t.match(/^###\s+(.*)$/))) { closeList(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = t.match(/^##\s+(.*)$/))) { closeList(); out.push(`<h2>${inline(m[1])}</h2>`); continue; }
    if ((m = t.match(/^#\s+(.*)$/))) { closeList(); out.push(`<h1>${inline(m[1])}</h1>`); continue; }
    if ((m = t.match(/^>\s?(.*)$/))) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = t.match(/^(\d+)\.\s+(.*)$/))) {
      if (!inOl) { closeList(); out.push('<ol>'); inOl = true; }
      out.push(`<li>${inline(m[2])}</li>`);
      continue;
    }
    if ((m = t.match(/^[-*]\s+(.*)$/))) {
      if (!inUl) { closeList(); out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(t)}</p>`);
  }
  closeTable();
  closeList();
  return out.join('\n');
}

/** 转录渲染：把 [MM:SS] 提出来做成时间戳徽标 */
function renderTranscript(text) {
  const out = [];
  for (const b of String(text).split('\n\n')) {
    const s = b.trim();
    if (!s) continue;
    const m = s.match(/^\[(\d+:\d+(?::\d+)?)\]\s*([\s\S]*)$/);
    if (m) out.push(`<p class="seg"><span class="ts">${esc(m[1])}</span>${esc(m[2])}</p>`);
    else if (s.startsWith('#')) out.push(`<h3>${esc(s.replace(/^#+\s*/, ''))}</h3>`);
    else out.push(`<p class="seg">${esc(s)}</p>`);
  }
  return out.join('\n');
}

function safeName(s) {
  return (String(s || '视频').replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ').trim().slice(0, 60)) || '视频';
}

function buildPath(dir, title, suffix) {
  const d = String(dir || '').replace(/[\\:*?"<>|]/g, '').replace(/^[\/\s]+|[\/\s]+$/g, '');
  return (d ? d + '/' : '') + safeName(title) + (suffix || '') + '.md';
}

/** 先读最新设置再合并写回 —— 设置页和结果页可能同时开着，直接写会覆盖对方刚改的项 */
async function persistSettings(patch) {
  const cur = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULTS, ...(cur.settings || {}), ...patch };
  await chrome.storage.local.set({ settings: merged });
  S = merged;
  return merged;
}

function setMsg(text, isErr) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = 'msg' + (isErr ? ' err' : '');
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 9000);
}

function contentOf(tab) {
  if (tab === 'transcript') return DATA ? DATA.markdown : '';
  if (tab === 'aisum') return AISUM ? AISUM.markdown : '';
  return '';
}

/** 把字幕整理成果："去语气词 + 补标点 + 分段"的可读文稿 */
function buildPolish() {
  if (!window.BiliPolish) throw new Error('整理模块未加载');
  const r = window.BiliPolish.polish(DATA.items || [], { withTime: false });
  const st = r.stats;
  const md = [
    `# ${DATA.title} —— 整理文稿`,
    '',
    `> UP主 **${DATA.uploader}** · 时长 **${DATA.durationText || ''}** · ` +
    `原始字幕 **${st.rawChars} 字** · 去掉 **${st.removedChars} 字**语气词与重复口误 · ` +
    `成稿 **${st.outChars} 字**（含新补的标点）`,
    '',
    '## 正文',
    '',
    r.paragraphs.join('\n\n'),
    '',
    '---',
    '',
    '*整理方式：删除语气词与重复口误、补全标点、按语义分段。只做可读化，不做摘要、不删改内容；' +
    '仍可能保留少量语音识别误差。*',
    '',
  ].join('\n');
  return { markdown: md, stats: st, body: r.paragraphs.join('\n\n') };
}

function modeOf(tab) {
  return tab === 'transcript' ? (S.transcriptMode || 'sub') : (S.aiMode || 'sub');
}

function dirOf(tab) {
  return tab === 'transcript' ? (S.transcriptDir || '') : (S.aiDir || '总结');
}

function saveFlagOf(tab) {
  return tab === 'transcript' ? !!S.transcriptSave : !!S.aiSave;
}

function syncFooter() {
  const isT = curTab === 'transcript';
  const mode = modeOf(curTab);
  $('dirLabel').textContent = isT ? '转录保存到' : '总结保存到';

  const showInput = mode === 'sub';
  $('dirInput').classList.toggle('hide', !showInput);
  if (showInput) {
    $('dirInput').value = dirOf(curTab);
    $('dirInput').placeholder = isT ? '如：字幕（留空 = 下载目录）' : '如：总结（留空 = 下载目录）';
  }

  const pickTag = $('dirPicked');
  const modeTag = $('modeTag');
  pickTag.classList.toggle('hide', mode !== 'dir');
  $('btnPick').classList.toggle('hide', mode !== 'dir');
  modeTag.classList.toggle('hide', mode !== 'ask');
  if (mode === 'ask') modeTag.textContent = '每次弹窗选位置';

  if (mode === 'dir' && window.BiliFsDir) {
    pickTag.textContent = '读取中…';
    window.BiliFsDir.getHandle(curTab).then((h) => {
      pickTag.textContent = h
        ? '已授权文件夹：' + h.name
        : '尚未授权文件夹 —— 点右边「更换文件夹」选择';
    }).catch(() => { pickTag.textContent = '尚未授权文件夹'; });
  }

  $('btnSave').textContent = isT ? '保存转录文字' : '保存 AI 总结';
}

async function save(tab, forceAsk) {
  tab = tab || curTab;
  const content = contentOf(tab);
  if (!content) { setMsg('没有可保存的内容', true); return; }

  const suffix = ({ transcript: '', aisum: '_AI总结' })[tab] || '';
  const mode = forceAsk ? 'ask' : modeOf(tab);
  const dir = dirOf(tab);

  // ---- 模式一：写入已授权的固定文件夹（唯一能写绝对路径的途径）
  if (mode === 'dir') {
    if (!window.BiliFsDir || !window.BiliFsDir.supported) {
      setMsg('当前浏览器不支持文件夹写入，请改用「每次询问」', true);
      return;
    }
    const handle = await window.BiliFsDir.getHandle(tab).catch(() => null);
    if (!handle) { setMsg('还没有授权文件夹，请到设置页点「选择文件夹」', true); return; }
    const ok = await window.BiliFsDir.ensurePermission(handle, 'readwrite');
    if (!ok) { setMsg('文件夹授权已失效，请到设置页重新选择一次', true); return; }
    try {
      const rel = buildPath('', DATA.title, suffix);
      await window.BiliFsDir.writeFile(handle, rel, content);
      setMsg('已写入「' + handle.name + '」/' + rel, false);
    } catch (e) {
      setMsg('写入失败：' + ((e && e.message) || e), true);
    }
    return;
  }

  // ---- 模式二 / 三：走浏览器下载接口
  const filename = buildPath(dir, DATA.title, suffix);
  const ask = mode === 'ask';
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: ask });
    setMsg(ask ? '已保存（你选择的位置）' : '已保存到 下载/' + filename, false);
  } catch (e) {
    setMsg('保存失败：' + ((e && e.message) || e), true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function copy() {
  const content = contentOf(curTab);
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    setMsg('已复制到剪贴板', false);
  } catch (e) {
    setMsg('复制失败，请手动选择内容复制', true);
  }
}

function switchTab(tab) {
  curTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('pane-transcript').classList.toggle('active', tab === 'transcript');
  $('pane-aisum').classList.toggle('active', tab === 'aisum');
  syncFooter();
}

(async function init() {
  const st = await chrome.storage.local.get(['lastResult', 'settings', 'openTab']);
  DATA = st.lastResult;
  const raw = st.settings || {};
  S = { ...DEFAULTS, ...raw };
  // 兼容旧版设置（以前只有 alwaysAsk，没有 mode）
  if (!raw.transcriptMode) S.transcriptMode = raw.alwaysAsk === false ? 'sub' : 'ask';

  if (!DATA) {
    $('ttl').textContent = '还没有提取结果';
    $('docT').innerHTML = '<div class="placeholder">请到 <b>B站视频页</b> 点击扩展图标，<br>点「提取转录文字」或「提取并生成 AI 总结」后再回到这里。</div>';
    $('btnSave').disabled = true;
    $('btnCopy').disabled = true;
    return;
  }

  $('ttl').textContent = DATA.title;
  document.title = DATA.title + ' · 文稿提取';
  const isYT = DATA.platform === 'youtube';
  const badge = DATA.translated
    ? '<span class="badge ai">YouTube 中文机翻字幕</span>'
    : isYT
      ? (DATA.isAi
          ? '<span class="badge ai">YouTube 自动字幕</span>'
          : '<span class="badge cc">UP主上传字幕</span>')
      : (DATA.isAi
          ? '<span class="badge ai">B站AI字幕 · 可能有同音字错误</span>'
          : '<span class="badge cc">UP主上传字幕</span>');
  $('meta').innerHTML = [
    `<span>UP主 ${esc(DATA.uploader)}</span>`,
    `<span>时长 ${esc(DATA.durationText || '')}</span>`,
    `<span>分P ${DATA.partGot}/${DATA.partTotal}</span>`,
    `<span>${DATA.chars} 字</span>`,
    badge,
  ].join('');
  $('cntT').textContent = DATA.chars ? `${DATA.chars} 字` : '';

  // 转录文字也做「补标点 + 分段」整理：保留原文用词（含语气词），只提高可读性。
  // 勾了「保留时间戳」时按段落保留时间锚点。失败或无条目时保持原文。
  if (window.BiliPolish && (DATA.items || []).length) {
    try {
      const seg = window.BiliPolish.polish(DATA.items, {
        withTime: !!S.withTimestamp,
        keepFillers: true,
        termFixes: S.termFixes,
      });
      if (seg.paragraphs && seg.paragraphs.length) {
        const mdHead = DATA.markdown.split('\n---\n')[0];
        DATA.text = seg.paragraphs.join('\n\n');
        DATA.markdown = (mdHead || `# ${DATA.title}`) + '\n\n---\n\n' + DATA.text + '\n';
      }
    } catch (e) { /* 整理失败则保持原文 */ }
  }

  $('docT').innerHTML = DATA.text
    ? `<h1>${esc(DATA.title)}</h1>` + renderTranscript(DATA.text)
    : '<div class="placeholder">没有可用的转录文字。</div>';

  // 整理文稿按需生成 —— 默认只放一个按钮，点了才跑，这样"提取"和"整理"是两个动作
  showAiPlaceholder();

  setTimeout(() => {
    $('btnSave').disabled = false;
    syncFooter();
    if (S.transcriptSave) setTimeout(() => save('transcript'), 300);
  }, 60);

  // 从面板点「提取并生成 AI 总结」进来的 → 自动切到文稿页并生成
  if (st.openTab === 'aisum') {
    setTimeout(() => { switchTab('aisum'); doAiSum(); }, 150);
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('btnSave').addEventListener('click', () => save());
  $('btnCopy').addEventListener('click', copy);
  $('btnAs').addEventListener('click', () => save(curTab, true));   // 强制弹保存对话框
  // 移动端没有 File System Access API，隐藏「选择文件夹」入口
  if (!window.showDirectoryPicker) {
    const bp = $('btnPick');
    if (bp) {
      bp.disabled = true;
      bp.title = '当前浏览器不支持目录授权，可到设置页改用「下载目录子目录」';
    }
  }

  $('btnPick').addEventListener('click', async () => {
    try {
      const h = await window.BiliFsDir.pick({ id: 'bili-' + curTab + '-dir', mode: 'readwrite' });
      await window.BiliFsDir.setHandle(curTab, h);
      const patch = curTab === 'transcript' ? { transcriptMode: 'dir' } : { aiMode: 'dir' };
      await persistSettings(patch);
      syncFooter();
      setMsg('已授权文件夹：' + h.name, false);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        setMsg('未授权。桌面、文档、下载这些根目录浏览器不允许授权，请选它们下面的子文件夹', true);
        return;
      }
      setMsg('选择失败：' + ((e && e.message) || e), true);
    }
  });
  $('dirInput').addEventListener('change', async () => {
    const v = $('dirInput').value.trim();
    const patch = curTab === 'transcript' ? { transcriptDir: v } : { aiDir: v };
    await persistSettings(patch);
    setMsg('路径已记住：' + (v || '浏览器下载目录'), false);
  });

  syncFooter();
})();

function showAiPlaceholder() {
  const cfg = S.ai || {};
  const ready = !!(cfg.baseUrl && cfg.model && cfg.apiKey);
  $('docA').innerHTML =
    '<div class="placeholder">' +
    (ready ? '' : '还没配置 AI 接口 —— 到扩展「<b>设置</b>」→「<b>AI 总结</b>」里填入接口地址、API Key 和模型名。') +
    '<br><br><button class="primary" id="btnDoAi">生成 AI 总结</button>' +
    '</div>';
  const b = $('btnDoAi');
  if (b) b.addEventListener('click', doAiSum);
}

async function doAiSum() {
  // 先读一次最新设置 —— 结果页可能开着，用户去设置页补配了 AI，不能沿用页面打开时的快照
  try {
    const cur = await chrome.storage.local.get('settings');
    if (cur.settings) S = { ...S, ...cur.settings };
  } catch (e) { /* 读不到就用快照 */ }
  const cfg = S.ai || {};
  if (!cfg.baseUrl || !cfg.model) {
    setMsg('还没配置 AI 接口，请到设置页填写', true);
    showAiPlaceholder();
    return;
  }

  $('docA').innerHTML = '<div class="placeholder">正在准备文稿…</div>';
  await new Promise((r) => setTimeout(r, 30));

  try {
    if (!POLISH) POLISH = buildPolish();
    $('docA').innerHTML =
      '<div class="placeholder">模型正在读文稿…<br><span id="aiNote"></span><br>' +
      '<span style="font-size:12px;color:#86909c">长文稿可能要几十秒，别关页面</span></div>';

    let streamEl = null;
    const onDelta = (delta, all) => {
      if (!delta) {
        const n = $('aiNote');
        if (n) n.textContent = all || '';
        return;
      }
      if (!streamEl) {
        const st = document.createElement('style');
        st.textContent = '#aiStream{white-space:pre-wrap;word-break:break-word;background:#fafbfc;' +
          'border:1px solid #e5e6eb;border-radius:8px;padding:20px 24px;font-family:inherit;' +
          'font-size:14px;line-height:1.95;max-height:62vh;overflow:auto;margin:0;}';
        document.head.appendChild(st);
        $('docA').innerHTML = '<pre id="aiStream"></pre>';
        streamEl = $('aiStream');
      }
      streamEl.textContent = all;
      streamEl.scrollTop = streamEl.scrollHeight;
    };

    const md = await window.BiliAiSum.summarize(cfg, {
      title: DATA.title,
      uploader: DATA.uploader,
      durationText: DATA.durationText,
      chars: DATA.chars,
      text: POLISH.body || DATA.text || '',
    }, onDelta);

    if (!md || !md.trim()) throw new Error('模型没有返回内容');
    AISUM = { markdown: md };
    $('docA').innerHTML = renderMd(md);
    $('cntA').textContent = md.replace(/\s/g, '').length + ' 字';
    setMsg('AI 总结已生成', false);
    if (S.aiSave) setTimeout(() => save('aisum'), 400);
  } catch (e) {
    const m = (e && e.message) || String(e);
    $('docA').innerHTML = '<div class="placeholder">生成失败：' + esc(m) +
      '<br><br>常见原因：Key 填错、模型名不对、余额不足、或该域名没拿到授权。' +
      '可以到设置页点「测试连接」先验证配置。</div>';
    setMsg('AI 总结失败：' + m, true);
  }
}
