/**
 * aisum.js —— 调用大模型做真正的「内容总结」
 *
 * 与 polish.js 的区别（两者是不同的事）：
 *   polish  = 清洗：删语气词、补标点，输出还是原始信息，只是好读了
 *   aisum   = 总结：读懂内容 → 抓逻辑主线 → 按主题重组 → 提炼观点，输出是"文章"
 *
 * 兼容所有 OpenAI 格式的接口（DeepSeek / 通义 / 智谱 / Kimi / 硅基流动 / OpenAI …），
 * 用户只需在设置页填「接口地址 + Key + 模型名」。
 */

(function (global) {
  'use strict';

  const PROMPT_HEAD = `你是一位资深内容编辑。下面是一个视频的完整字幕文稿，请把它整理成一份**结构化内容总结**。

视频信息：
- 标题：{title}
- UP主：{uploader}
- 时长：{duration}
- 字幕字数：{chars}

写法要求：
1. 开头用一两句话交代：这是谁讲的、多长的视频、整体在讲什么。
2. 按内容的**逻辑主线**分成 5–8 个小节。每节一个加粗小标题，形如「**一、开篇的主张：别问路线，问证据**」——
   标题要提炼出这一节的观点，不要用「第一部分」「内容概述」这种空标题。
3. 每节写清楚：核心主张 + 支撑它的例子、对比、数据。**具体的人名、数字、工具名、案例都要保留**，
   不要写成泛泛而谈的鸡汤。视频里举的对比例子（比如两个候选人对比）要复现出来。
4. 删掉口语语气词、重复表述、寒暄、跑题内容，但**不要丢失任何实质性信息**。
5. 正面陈述观点，不要反复用「作者认为」「视频里说」这类套话。
6. 视频里如果明确划了边界或提了免责（比如"这些数据不等于就业保证"），要如实保留，不要美化。
7. 结尾用一句话收束全文，格式：**一句话总结**：……

风格：像一篇写给同行看的高密度读书笔记。直接、准确、不啰嗦、不堆形容词。用 Markdown 输出，
不要写"以下是总结"之类的开场白，直接从定位句开始。`;

  const CHUNK_PROMPT = `下面是长视频字幕的第 {idx}/{total} 段。请提取这一段的**全部实质性信息**，
用要点形式输出（不要总结成一句话，要尽量全）：
- 讲了什么观点
- 用了什么例子、数据、对比
- 提到了哪些具体的人名、工具、数字
只做提取，不要评价。用简洁的中文分条列出。`;

  function endpoint(baseUrl) {
    let u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) throw new Error('还没填接口地址');
    if (!/\/chat\/completions$/.test(u)) u += '/chat/completions';
    return u;
  }

  /** 一次对话请求；传了 onDelta 就走流式 */
  async function chat(cfg, messages, onDelta) {
    const resp = await fetch(endpoint(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (cfg.apiKey || ''),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.3,
        max_tokens: cfg.maxTokens || 4000,
        stream: !!onDelta,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('接口返回 ' + resp.status + ' ' + t.slice(0, 300));
    }

    if (!onDelta) {
      const j = await resp.json();
      const c = j.choices && j.choices[0] && j.choices[0].message;
      if (!c) throw new Error('接口返回格式不认识：' + JSON.stringify(j).slice(0, 200));
      return c.content || '';
    }

    // SSE 流式
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s || !s.startsWith('data:')) continue;
        const d = s.slice(5).trim();
        if (d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          const delta = (j.choices && j.choices[0] && j.choices[0].delta
            && j.choices[0].delta.content) || '';
          if (delta) {
            out += delta;
            onDelta(delta, out);
          }
        } catch (e) { /* 忽略不完整分片 */ }
      }
    }
    return out;
  }

  function splitChunks(text, size) {
    const paras = String(text).split('\n\n');
    const out = [];
    let buf = '';
    for (const p of paras) {
      if (buf && buf.length + p.length > size) {
        out.push(buf);
        buf = '';
      }
      buf += (buf ? '\n\n' : '') + p;
    }
    if (buf) out.push(buf);
    return out;
  }

  /**
   * @param {{baseUrl:string, apiKey:string, model:string, temperature?:number, maxTokens?:number}} cfg
   * @param {{title:string, uploader:string, durationText:string, chars:number, text:string}} video
   * @param {(delta:string, all:string)=>void} onDelta
   * @param {number} chunkLimit 超过这个字数就分段提取要点再合并
   */
  async function summarize(cfg, video, onDelta, chunkLimit) {
    if (!cfg || !cfg.baseUrl || !cfg.model) throw new Error('还没配置 AI 接口（设置页 → AI 总结）');
    if (cfg.needKey !== false && !cfg.apiKey) throw new Error('还没填 API Key');

    const limit = chunkLimit || 9000;
    const head = PROMPT_HEAD
      .replace('{title}', video.title || '')
      .replace('{uploader}', video.uploader || '')
      .replace('{duration}', video.durationText || '')
      .replace('{chars}', String(video.chars || 0));

    let body = video.text || '';

    // 超长文稿：先分段提取要点，再把要点交给模型成文，避免一次性超出上下文
    if (body.length > limit) {
      const chunks = splitChunks(body, limit);
      const notes = [];
      for (let i = 0; i < chunks.length; i++) {
        if (onDelta) onDelta('', `（正在分段提取要点 ${i + 1}/${chunks.length}…）`);
        const p = CHUNK_PROMPT.replace('{idx}', String(i + 1)).replace('{total}', String(chunks.length));
        const note = await chat(cfg, [
          { role: 'system', content: '你是严谨的内容提取助手。' },
          { role: 'user', content: p + '\n\n---\n' + chunks[i] },
        ]);
        notes.push(`【第 ${i + 1} 段要点】\n${note}`);
      }
      body = '（原文稿过长，以下为分段提取的要点，请据此成文；信息以要点为准。）\n\n'
        + notes.join('\n\n');
    }

    const messages = [
      { role: 'system', content: '你是资深内容编辑，擅长把口语化长文稿整理成高密度结构化总结。' },
      { role: 'user', content: head + '\n\n---\n字幕文稿：\n' + body + '\n---' },
    ];
    return await chat(cfg, messages, onDelta);
  }

  /** 测试配置是否可用 */
  async function testConnection(cfg) {
    const r = await chat(cfg, [
      { role: 'user', content: '只回复两个字：可用' },
    ]);
    return r.trim();
  }

  global.BiliAiSum = { summarize, testConnection, endpoint };
})(typeof window !== 'undefined' ? window : self);
