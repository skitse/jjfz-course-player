// ==UserScript==
// @name         积极分子培训视频自动播放与题库辅助
// @namespace    https://github.com/skitse/jjfz-course-player
// @version      0.4.0
// @description  培训视频后台续播、自动切课与静音；内置题库匹配、可靠答案填写，每章手动交卷。
// @match        *://*/jjfz/lesson*
// @match        *://*/jjfz/play*
// @match        *://*/jjfz/exam_center*
// @license      MIT
// @homepageURL  https://github.com/skitse/jjfz-course-player
// @supportURL   https://github.com/skitse/jjfz-course-player/issues
// @updateURL    https://raw.githubusercontent.com/skitse/jjfz-course-player/main/jjfz-course-player.user.js
// @downloadURL  https://raw.githubusercontent.com/skitse/jjfz-course-player/main/jjfz-course-player.user.js
// @run-at       document-idle
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  const page = new URL(location.href);
  if (!['http:', 'https:'].includes(page.protocol)) return;

  const path = page.pathname.replace(/\/$/, '') || '/';
  const prefix = path.match(/^(.*)\/(?:lesson|play)$/)?.[1] ?? '/jjfz';
  const routesKey = 'routes:' + page.origin;
  const configuredRoutes = parseRoutes(GM_getValue(routesKey, null));
  const defaultRoutes = [prefix + '/lesson', prefix + '/lesson/video', prefix + '/play'];
  const [centerPath, catalogPath, playerPath] = configuredRoutes?.includes(path) ? configuredRoutes : defaultRoutes;
  GM_registerMenuCommand('配置本站页面地址', () => {
    const value = prompt('每行一个本站地址：课程中心、课件列表、视频播放页。需要自定义答题地址时，再加章节自测页和综合测试页，共五行。支持完整网址或路径，留空恢复默认。', (configuredRoutes ?? defaultRoutes).join('\n'));
    if (value === null) return;
    const routes = value.trim() ? parseRoutes(value.trim().split(/\r?\n/)) : null;
    if (value.trim() && !routes) {
      alert('请输入三个或五个不同的本站地址。');
      return;
    }
    GM_setValue(routesKey, routes);
    location.reload();
  });

  const stage = page.searchParams.get('stg');
  if (![centerPath, playerPath].includes(path) || !stage) return;

  const centerUrl = new URL(centerPath, page);
  centerUrl.searchParams.set('stg', stage);
  const centerHasCourses = path === centerPath && listCourses(document, page).length > 0;
  const isPlayer = path === playerPath && playbackUrl(page.href) && document.querySelector('.vlist .vitem.active');
  if (!centerHasCourses && !isPlayer) return;

  const scope = centerPath === '/jjfz/lesson' && catalogPath === '/jjfz/lesson/video' && playerPath === '/jjfz/play'
    ? stage : JSON.stringify([centerPath, catalogPath, playerPath, stage]);
  const enabledKey = 'jjfz-course-player:enabled:' + scope;
  const queueKey = 'jjfz-course-player:queue:' + scope;
  const approvedKey = 'approved:' + page.origin;
  const muteKey = 'muted:' + page.origin;
  const resumeLoadGraceMs = 3500; // 网站最多等 3 秒读取断点
  const pauseRecoveryDelayMs = 1200;
  const manualPauseWindowMs = 800;
  const minimumProgressBetweenRecoveries = 3;
  const stallCheckMs = 10000;
  const stallTimeoutMs = 75000;
  const stallRetryLimit = 2;
  const stallKey = 'jjfz-course-player:stall:' + [scope, page.searchParams.get('v_id'), page.searchParams.get('r_id')].join(':');
  const handledButtons = new WeakSet();
  let queue = loadQueue();
  let building = false;
  let status;
  let enabled = GM_getValue(approvedKey, false) && (queue?.running
    ? isCurrentVideo(queue.entries[queue.index])
    : sessionStorage.getItem(enabledKey) === '1');
  let startRequested = enabled;
  let startTimer = null;
  let advanced = false;
  let muted = GM_getValue(muteKey, false);
  let mutedVideo;
  let playedVideo;
  let recoveryVideo;
  let lastRecovery;
  let lastPlaybackInput = -Infinity;
  let playbackProgress;
  let stalledRetries;
  let reloading = false;

  function showStatus(message) {
    if (!status) {
      status = document.createElement('div');
      status.setAttribute('role', 'status');
      Object.assign(status.style, {
        position: 'fixed', bottom: '12px', left: '12px', zIndex: '9999',
        background: '#242424', color: '#fff', borderRadius: '8px',
        font: '14px/1.5 sans-serif', maxWidth: 'min(480px, 85vw)', padding: '8px 12px',
        pointerEvents: 'none'
      });
      document.body.append(status);
    }
    if (status.textContent !== message) status.textContent = message;
  }

  function parseRoutes(values) {
    if (!Array.isArray(values) || ![3, 5].includes(values.length)) return null;
    const paths = [];
    for (const value of values) {
      const address = typeof value === 'string' && value.trim();
      if (!address || !/^(?:\/|https?:\/\/)/i.test(address) || !URL.canParse(address, page.origin)) return null;
      const url = new URL(address, page.origin);
      if (url.origin !== page.origin || url.username || url.password) return null;
      paths.push(url.pathname.replace(/\/$/, '') || '/');
    }
    return new Set(paths).size === paths.length ? paths : null;
  }

  function siteUrl(href, expectedPath, base = page) {
    if (!href || !URL.canParse(href, base)) return null;
    const url = new URL(href, base);
    return url.origin === page.origin && !url.username && !url.password
      && (url.pathname.replace(/\/$/, '') || '/') === expectedPath && url.searchParams.get('stg') === stage
      ? url : null;
  }

  function playbackUrl(href, base) {
    const url = siteUrl(href, playerPath, base);
    return url?.searchParams.get('r') === 'video' && /^\d+$/.test(url.searchParams.get('v_id'))
      ? url : null;
  }

  function isCurrentVideo(entry) {
    const expected = playbackUrl(entry?.href);
    const actual = playbackUrl(page.href);
    if (!expected || !actual) return false;
    const episode = expected.searchParams.get('r_id');
    if (expected.searchParams.get('v_id') !== actual.searchParams.get('v_id')) return false;
    if (!episode) return true;
    const selected = document.querySelector('.vlist .vitem.active')?.closest('a');
    const currentEpisode = actual.searchParams.get('r_id')
      ?? playbackUrl(selected?.href)?.searchParams.get('r_id');
    return episode === currentEpisode;
  }

  function saveQueue() {
    sessionStorage.setItem(queueKey, JSON.stringify(queue));
  }

  function loadQueue() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(queueKey));
      if (Array.isArray(saved?.entries) && Number.isInteger(saved.index)
        && saved.index >= 0 && saved.index <= saved.entries.length
        && typeof saved.running === 'boolean'
        && saved.entries.every(entry => playbackUrl(entry?.href)
          && typeof entry.title === 'string' && typeof entry.course === 'string')) {
        return saved;
      }
    } catch {
      // 目录可从网站重新生成。
    }
    return null;
  }

  function listCourses(doc, base) {
    const courses = new Map();
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const url = siteUrl(anchor.getAttribute('href'), catalogPath, base);
      const id = url?.searchParams.get('lesson_id');
      if (!id || courses.has(id)) continue;

      const summary = anchor.closest('li')?.querySelector('dl')?.textContent;
      const required = summary?.match(/(?<!已完成)必读课件\s*[：:]\s*(\d+)/);
      const title = anchor.textContent.replace(/\s+/g, ' ').trim() || anchor.getAttribute('title')?.trim();
      if (!required || !title) continue;
      url.searchParams.set('required', '1');
      courses.set(id, { id, url, title, count: Number(required[1]) });
    }
    return [...courses.values()];
  }

  function listEpisodes(card, course, base) {
    const meta = card.querySelector('.l_list_num');
    if (meta?.querySelector('.r_read')?.textContent.replace(/\s+/g, '') !== '必修') return [];

    const title = card.querySelector('.l_list_right h2 a');
    const main = playbackUrl(title?.getAttribute('href'), base);
    const declared = Number(meta.textContent.match(/共\s*(\d+)\s*讲/)?.[1]);
    const links = [...card.querySelectorAll('a[href*="r_id="]')].map(anchor => ({
      url: playbackUrl(anchor.getAttribute('href'), base), title: anchor.textContent.trim()
    }));
    const sameGroup = links.every(link => link.url && link.url.searchParams.get('v_id') === main?.searchParams.get('v_id')
      && /^\d+$/.test(link.url.searchParams.get('r_id')));
    const uniqueEpisodes = new Set(links.map(link => link.url?.searchParams.get('r_id')));
    if (!main || !sameGroup || uniqueEpisodes.size !== links.length || declared !== (links.length || 1)) {
      throw new Error(`${title?.textContent.trim() || course}的分集数与目录不符。`);
    }
    return (links.length ? links : [{ url: main, title: title.textContent.trim() }])
      .map(link => ({ href: link.url.href, title: link.title, course }));
  }

  async function* readPages(start, expectedPath, validate, firstDocument) {
    const visited = new Set();
    let next = start;

    while (next) {
      if (visited.has(next.href)) throw new Error('目录的分页链接重复。');
      visited.add(next.href);
      let doc = firstDocument;
      firstDocument = null;
      if (!doc) {
        const response = await fetch(next, { redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`目录无法读取（HTTP ${response.status}）。`);
        doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      }

      yield { doc, url: next };
      const nextLink = [...doc.querySelectorAll('a[href]')].find(anchor => anchor.textContent.trim() === '下一页');
      next = siteUrl(nextLink?.getAttribute('href'), expectedPath, next);
      if (nextLink && (!next || !validate(next))) throw new Error('分页链接离开了当前目录。');
    }
  }

  async function readCourses() {
    const courses = new Map();
    const currentDocument = page.href === centerUrl.href ? document : null;
    for await (const { doc, url } of readPages(centerUrl, centerPath, () => true, currentDocument)) {
      const listed = listCourses(doc, url);
      if (!listed.length) throw new Error('没有找到课程，或课程中心需要重新登录。');
      for (const course of listed) courses.set(course.id, course);
    }
    return [...courses.values()];
  }

  async function readCatalog(course) {
    const groups = new Set();
    const entries = [];
    const inCourse = url => url.searchParams.get('required') === '1' && url.searchParams.get('lesson_id') === course.id;
    for await (const { doc, url } of readPages(course.url, catalogPath, inCourse)) {
      for (const title of doc.querySelectorAll('.l_list_right h2 a')) {
        const card = title.closest('li');
        if (!card) throw new Error(`${course.title}的课件结构已变化。`);
        const episodes = listEpisodes(card, course.title, url);
        if (!episodes.length) continue;
        const group = new URL(episodes[0].href).searchParams.get('v_id');
        if (groups.has(group)) throw new Error(`${course.title}的课件链接重复。`);
        groups.add(group);
        entries.push(...episodes);
      }
    }

    if (groups.size !== course.count) {
      throw new Error(`${course.title}应有 ${course.count} 个必修课件，目录读到了 ${groups.size} 个。`);
    }
    return entries;
  }

  function describeQueue() {
    const entry = queue.entries[queue.index];
    return entry
      ? `${queue.running ? '播放队列' : '队列已暂停'} · ${queue.index + 1}/${queue.entries.length} · ${entry.course} · ${entry.title}`
      : `队列已结束 · ${queue.entries.length} 个视频均已收到完成回执 · 请手动开始章节自测`;
  }

  function resumeQueue() {
    const entry = queue.entries[queue.index];
    const url = playbackUrl(entry?.href);
    if (!url) return;
    GM_setValue(approvedKey, true);
    queue.running = true;
    saveQueue();
    sessionStorage.removeItem(enabledKey);
    if (!isCurrentVideo(entry)) {
      location.assign(url.href);
      return;
    }
    enabled = true;
    startRequested = true;
    showStatus(describeQueue());
    update();
  }

  async function startQueue({ rebuild = false, fromCurrent = false } = {}) {
    if (building) return;
    if (!rebuild && queue?.entries[queue.index]) {
      resumeQueue();
      return;
    }
    building = true;
    try {
      const courses = await readCourses();
      const entries = [];
      for (let index = 0; index < courses.length; index += 3) {
        showStatus(`正在读取必修目录 · ${index}/${courses.length} 门课`);
        entries.push(...(await Promise.all(courses.slice(index, index + 3).map(readCatalog))).flat());
      }
      if (!entries.length) throw new Error('没有读到必修视频。');
      const firstIndex = fromCurrent ? entries.findIndex(isCurrentVideo) : 0;
      if (firstIndex < 0) throw new Error('当前视频没有出现在必修目录里。');
      queue = { entries: entries.slice(firstIndex), index: 0, running: true };
      resumeQueue();
    } catch (error) {
      showStatus(`队列未启动：${error.message} 可在油猴菜单重试。`);
    } finally {
      building = false;
    }
  }

  function findContinueButton() {
    for (const overlay of visiblePlayerOverlays()) {
      // 两种提示由同一个播放器弹窗函数生成。
      const [title, message, controls] = overlay.firstElementChild?.children ?? [];
      const text = message?.textContent.trim();
      const timedPause = title?.textContent.trim() === '提示'
        && text === '视频已暂停，点击按钮后继续学习！';
      const resumePrompt = title?.textContent.trim() === '继续观看'
        && text?.startsWith('该视频已播放至');
      if (!timedPause && !resumePrompt) continue;

      const label = timedPause ? '继续' : '继续播放';
      return [...(controls?.querySelectorAll('button') ?? [])].find(
        button => button.textContent.trim() === label && !button.disabled
      );
    }
  }

  function visiblePlayerOverlays() {
    return [...document.body.children].filter(node => node.style?.zIndex === '2147483000'
      && node.getClientRects().length);
  }

  function hasBlockingDialog() {
    return visiblePlayerOverlays().length > 0
      || [...document.querySelectorAll('.layui-layer, .layui-layer-dialog, [role="dialog"], dialog[open]')]
        .some(dialog => dialog.getClientRects().length);
  }

  function advanceAfterCompletion(video) {
    if (advanced || !video?.ended) return;

    const confirmed = [...document.querySelectorAll('.layui-layer-dialog .layui-layer-content')]
      .some(dialog => dialog.getClientRects().length && dialog.textContent.trim() === '当前视频播放完毕！');
    if (!confirmed) return;
    advanced = true;
    sessionStorage.removeItem(stallKey);

    if (queue?.running && isCurrentVideo(queue.entries[queue.index])) {
      queue.index++;
      const entry = queue.entries[queue.index];
      queue.running = Boolean(entry);
      saveQueue();
      location.assign(entry ? playbackUrl(entry.href).href : centerUrl.href);
      return;
    }

    const current = document.querySelector('.vlist .vitem.active')?.closest('a');
    const next = current?.nextElementSibling;
    if (!next?.matches('a[href]')) return;

    const nextPage = new URL(next.href, page);
    if (playbackUrl(nextPage.href)
      && nextPage.searchParams.get('v_id') === page.searchParams.get('v_id')
      && nextPage.searchParams.get('r_id')) {
      location.assign(nextPage.href);
    }
  }

  async function playVideo(video) {
    try {
      await video.play();
    } catch (error) {
      if (error.name !== 'NotAllowedError' || !enabled
        || !video.isConnected || hasBlockingDialog()) return;

      const wasMuted = video.muted;
      video.muted = true;
      try {
        await video.play();
      } catch {
        video.muted = wasMuted;
        showStatus('浏览器拦截了自动播放。');
      }
    }
  }

  function schedulePlayback(video, recovering) {
    if (startTimer !== null || !video || video.readyState < 1) return;
    startTimer = setTimeout(() => {
      startTimer = null;
      if (!enabled || !(startRequested || recoveryVideo === video)) return;
      if (!video.isConnected || findContinueButton()) {
        update();
        return;
      }
      if (hasBlockingDialog()) return;

      startRequested = false;
      if (recoveryVideo === video) {
        recoveryVideo = null;
        lastRecovery = { video, time: video.currentTime, hidden: document.hidden };
      }
      if (video.paused && !video.ended && !video.error) void playVideo(video);
    }, recovering ? pauseRecoveryDelayMs : resumeLoadGraceMs);
  }

  function handlePlaying(event) {
    if (!enabled || event.target !== findVideo()) return;
    playedVideo = event.target;
    startRequested = false;
    recoveryVideo = null;
  }

  function handlePause(event) {
    const video = event.target;
    if (!enabled || video !== playedVideo || video !== findVideo() || video.ended || video.error) return;
    if (Date.now() - lastPlaybackInput < manualPauseWindowMs) return;
    if (lastRecovery?.video === video && lastRecovery.hidden === document.hidden
      && video.currentTime - lastRecovery.time < minimumProgressBetweenRecoveries) return;

    recoveryVideo = video;
    update();
  }

  function markPlaybackInput(event) {
    if (!event.isTrusted || !enabled) return;
    const target = event.target;
    if (event.type === 'pointerdown' && target?.closest?.('video, .xgplayer-progress')) {
      playbackProgress = null;
    }
    const playerClick = event.type === 'pointerdown' && target?.closest?.('video, .xgplayer-play, .xgplayer-start');
    const playbackKey = event.type === 'keydown' && [' ', 'k', 'MediaPlayPause'].includes(event.key)
      && !target?.closest?.('input, textarea, button, [contenteditable="true"]');
    if (!playerClick && !playbackKey) return;

    lastPlaybackInput = Date.now();
    recoveryVideo = null;
  }

  function watchPlaybackProgress() {
    const video = findVideo();
    if (!enabled || reloading || video !== playedVideo || !video
      || video.paused || video.ended || hasBlockingDialog()) {
      playbackProgress = null;
      return;
    }

    const now = performance.now();
    if (!playbackProgress || playbackProgress.video !== video
      || video.currentTime > playbackProgress.time + 1) {
      playbackProgress = { video, time: video.currentTime, at: now };
    }

    if (stalledRetries && video.currentTime > stalledRetries.anchor + 5) {
      stalledRetries = null;
      sessionStorage.removeItem(stallKey);
    }
    if (now - playbackProgress.at < stallTimeoutMs) return;

    const attempts = stalledRetries?.attempts ?? 0;
    if (attempts >= stallRetryLimit) {
      showStatus('视频长时间没有进展，已停止自动重载。');
      return;
    }

    stalledRetries = { attempts: attempts + 1, anchor: Math.max(stalledRetries?.anchor ?? 0, playbackProgress.time) };
    sessionStorage.setItem(stallKey, JSON.stringify(stalledRetries));
    reloading = true;
    showStatus('视频长时间没有进展，正在重新载入并从网站断点续播。');
    location.reload();
  }

  function update() {
    if (!enabled) return;

    const video = findVideo();
    if (muted && video && mutedVideo !== video) {
      video.muted = true;
      mutedVideo = video;
    }
    if (video && !video.paused && !video.ended) playedVideo = video;

    const button = findContinueButton();
    if (button) {
      startRequested = false;
      recoveryVideo = null;
      if (!handledButtons.has(button)) {
        handledButtons.add(button);
        lastRecovery = null;
        button.click();
      }
      return;
    }

    advanceAfterCompletion(video);
    if (queue?.running && video?.ended && !advanced) {
      showStatus(describeQueue() + ' · 等待网站完成回执');
    }
    if (startRequested || (video && recoveryVideo === video)) {
      schedulePlayback(video, recoveryVideo === video);
    }
  }

  function setMute(value) {
    muted = value;
    GM_setValue(muteKey, value);
    const video = findVideo();
    if (video) {
      video.muted = value;
      mutedVideo = video;
    }
  }

  function keepMute(event) {
    if (muted && event.target === mutedVideo && !mutedVideo.muted) mutedVideo.muted = true;
  }

  function findVideo() {
    const videos = document.querySelectorAll('video');
    return videos.length === 1 ? videos[0] : document.querySelector('.xgplayer video');
  }

  GM_registerMenuCommand('静音播放（记住此站点）', () => setMute(true));
  GM_registerMenuCommand('恢复声音（记住此站点）', () => setMute(false));

  if (path === centerPath) {
    GM_registerMenuCommand('开始或继续全部必修视频', () => startQueue());
    if (queue?.entries[queue.index]) {
      GM_registerMenuCommand('重新读取必修目录并开始', () => startQueue({ rebuild: true }));
    }
    if (queue) showStatus(describeQueue());
    return;
  }

  GM_registerMenuCommand('从当前视频开始必修队列', () => startQueue({ rebuild: true, fromCurrent: true }));
  GM_registerMenuCommand('开启此标签页的自动续播', () => {
    if (queue?.entries[queue.index]) {
      resumeQueue();
      return;
    }
    if (enabled) return;
    GM_setValue(approvedKey, true);
    sessionStorage.setItem(enabledKey, '1');
    enabled = true;
    startRequested = true;
    update();
  });

  GM_registerMenuCommand('关闭此标签页的自动续播', () => {
    sessionStorage.removeItem(enabledKey);
    enabled = false;
    startRequested = false;
    recoveryVideo = null;
    clearTimeout(startTimer);
    startTimer = null;
    if (queue?.running) {
      queue.running = false;
      saveQueue();
      showStatus(describeQueue());
    }
  });

  if (queue?.entries[queue.index] && isCurrentVideo(queue.entries[queue.index])) showStatus(describeQueue());
  try {
    stalledRetries = JSON.parse(sessionStorage.getItem(stallKey));
  } catch {
    sessionStorage.removeItem(stallKey);
  }
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('loadedmetadata', update, true);
  document.addEventListener('ended', update, true);
  document.addEventListener('playing', handlePlaying, true);
  document.addEventListener('pause', handlePause, true);
  document.addEventListener('pointerdown', markPlaybackInput, true);
  document.addEventListener('keydown', markPlaybackInput, true);
  document.addEventListener('volumechange', keepMute, true);
  document.addEventListener('visibilitychange', () => {
    playbackProgress = null;
    update();
  });
  document.addEventListener('resume', () => {
    playbackProgress = null;
    update();
  });
  setInterval(watchPlaybackProgress, stallCheckMs);
  update();
})();

(() => {
  "use strict";
function normalizeText(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/(?<=\d)\.(?=\d)/g, '\uE001')
    .replace(/[（(]\s*[）)]|_{2,}/g, '□')
    .replace(/[\p{P}\p{Z}\s]/gu, character => /[+\-=%<>/—–]/.test(character) ? character : '')
    .replace(/\uE001/g, '.');
}

function optionText(value, type) {
  const text = normalizeText(value);
  if (type !== 'boolean') return text;
  if (['正确', '对', '是', '√'].includes(text)) return 'true';
  if (['错误', '错', '否', '×'].includes(text)) return 'false';
  return text;
}

function criticalText(text) {
  return String(text).normalize('NFKC').replace(/\s/g, '').match(
    /\d+(?:\.\d+)?|[一二三四五六七八九十百千万两]+(?=[年月日次个届项])|不得|不能|不|未|无|非|否|必须|应当|可以|只能|至少|以上|以下|以前|以后|之前|之后|正确|错误|首次|最早|最初|根本|主要|重要|首要|[+\-=%<>/—–≤≥≠]/g
  )?.join('|') ?? '';
}

function textSimilarity(left, right) {
  if (!left.length || !right.length) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] !== right[j - 1]));
    }
    previous = next;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function createMatcher(bank) {
  const records = bank.map(row => ({ ...row, normalized: normalizeText(row.question) }));
  const index = new Map();
  for (const row of records) {
    const key = row.type + ':' + row.normalized;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  const signature = (values, type) => JSON.stringify(values.map(value => optionText(value, type)).sort());
  return function match(question) {
    const type = question.type;
    const text = normalizeText(question.question);
    const options = question.options ?? [];
    const texts = options.map(o => optionText(o.text, type));
    if (!text || !['single', 'multiple', 'boolean', 'fill'].includes(type)
      || (type !== 'fill' && (texts.length < 2 || new Set(texts).size !== texts.length))) return { status: 'invalid' };
    const exact = index.get(type + ':' + text) ?? [];
    if (exact.length) {
      const compatible = exact.filter(row => type === 'fill' || signature(row.options, type) === signature(options.map(o => o.text), type));
      if (!compatible.length) return { status: 'options-changed' };
      const answers = new Map(compatible.map(row => [signature(row.answers, type), row.answers]));
      if (answers.size !== 1) return { status: 'conflict' };
      const answer = [...answers.values()][0];
      if ((type === 'fill' || type !== 'multiple') && answer.length !== 1) return { status: 'conflict' };
      if (type === 'fill') return { status: 'exact', text: answer[0], answers: answer };
      const keys = answer.map(a => optionText(a, type));
      if (keys.some(a => !texts.includes(a)) || new Set(keys).size !== keys.length) return { status: 'conflict' };
      const mapped = options.filter(o => keys.includes(optionText(o.text, type)));
      return { status: 'exact', values: mapped.map(o => o.value), answers: answer };
    }
    if (text.length < 30 || text.length > 1200) return { status: 'missing' };
    const near = records.filter(row => row.type === type && criticalText(row.question) === criticalText(question.question)
      && Math.abs(row.normalized.length - text.length) < Math.max(text.length * 0.08, 2)
      && (type === 'fill' || signature(row.options, type) === signature(options.map(o => o.text), type)))
      .map(row => ({ row, score: textSimilarity(text, row.normalized) })).filter(row => row.score >= 0.94)
      .sort((a, b) => b.score - a.score);
    if (!near.length) return { status: 'missing' };
    return { status: 'similar', answers: near[0].row.answers, question: near[0].row.question, score: near[0].score };
  };
}

function parseQuestion(doc, expectedIndex) {
  const heading = doc.querySelector('.exam_h2');
  const typeText = doc.querySelector('.e_cont_title span')?.textContent ?? '';
  const type = typeText.includes('多选') ? 'multiple' : typeText.includes('判断') ? 'boolean'
    : typeText.includes('填空') ? 'fill' : typeText.includes('单选') ? 'single' : null;
  const container = doc.querySelector('.summary_question') ?? doc.querySelector('[qindex]');
  const index = Number(container?.getAttribute('qindex'));
  const qids = [...doc.querySelectorAll('[qid]')].map(e => e.getAttribute('qid'));
  const qid = qids[0];
  if (!heading || !type || !qid || !/^\d+$/.test(qid) || qids.some(id => id !== qid)) throw Error('题目结构或标识发生变化。');
  if (index !== expectedIndex) throw Error('题目序号发生变化。');
  const question = heading.textContent.replace(/^\s*\d+[.、．]\s*/, '').trim();
  const labels = [...doc.querySelectorAll('.answer_list label,.answer_list_box label')];
  const options = labels.map(label => ({ text: label.textContent.replace(/^\s*[A-Z][、.．]\s*/, '').trim(), value: label.querySelector('input')?.value }));
  if (!question || (type !== 'fill' && (options.length < 2 || options.some(o => !o.value || !o.text)
    || new Set(options.map(o => o.value)).size !== options.length))) throw Error('题目选项发生变化。');
  return { index, qid, type, question, options,
    selected: labels.filter(l => l.classList.contains('checked') || l.querySelector('input')?.checked).map(l => l.querySelector('input').value),
    answer: type === 'fill' ? container.value.trim() : '' };
}


function runQuestionAssistant(bank) {
  const page = new URL(location.href);
  if (!['http:', 'https:'].includes(page.protocol)) return;
  const stage = page.searchParams.get('stg');
  if (!stage) return;
  const cleanPath = url => url.pathname.replace(/\/$/, '') || '/';
  const configured = GM_getValue('routes:' + page.origin, null);
  const defaults = ['/jjfz/lesson', '/jjfz/lesson/video', '/jjfz/play', '/jjfz/lesson/exam', '/jjfz/exam_center/end_exam'];
  let routes = defaults;
  if (Array.isArray(configured) && [3, 5].includes(configured.length)) {
    try {
      const urls = configured.map(path => new URL(path, page.origin));
      if (urls.every(url => url.origin === page.origin && !url.username && !url.password)) {
        const paths = urls.map(cleanPath);
        routes = paths.length === 5 ? paths : [...paths, paths[0] + '/exam', paths[0].replace(/\/[^/]+$/, '') + '/exam_center/end_exam'];
      }
    } catch { /* 保留默认地址。 */ }
  }
  const path = cleanPath(page);
  const chapter = path === routes[3];
  if (!chapter && path !== routes[4]) return;
  const lesson = page.searchParams.get('lesson_id');
  if (chapter && !/^\d+$/.test(lesson)) return;
  const count = document.querySelectorAll('.exam_num_lists li').length;
  if (!count || count > 500 || !document.querySelector('.exam_cont_left .exam_h2')) return;
  if (document.getElementById('jjfz-question-assistant')) return;

  const endpoint = chapter ? path : path.replace(/\/[^/]+$/, '');
  const match = createMatcher(bank);
  const initialHref = page.href;
  const touched = new Set();
  let rows = [];
  let busy = false;
  const preference = 'question-mode:' + page.origin;
  const panel = document.createElement('details');
  panel.id = 'jjfz-question-assistant';
  panel.open = true;
  Object.assign(panel.style, {
    position: 'fixed', right: '12px', bottom: '12px', width: 'min(460px, 90vw)', zIndex: '10000',
    background: '#fff', color: '#20252b', border: '1px solid #bec8d2', borderRadius: '10px',
    boxShadow: '0 3px 18px #0003', padding: '12px', font: '14px/1.55 sans-serif'
  });
  const element = (tag, text, parent = panel) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    parent.append(node);
    return node;
  };
  element('summary', `题库辅助 · ${bank.length} 题 · 手动交卷`);
  element('p', '视频学习结束后，由你打开自测。匹配和填写在当前试卷内进行，每章最后由你在网站交卷。');
  const mode = element('select');
  mode.setAttribute('aria-label', '答题模式');
  const preferredMode = GM_getValue(preference, 'manual') === 'reference' ? 'reference' : 'manual';
  for (const [value, text] of [['manual', '填写可靠匹配的答案，每章手动交卷'], ['reference', '仅显示参考答案，自己填写并交卷']]) {
    const option = element('option', text, mode);
    option.value = value;
    if (value === preferredMode) option.selected = true;
  }
  const controls = element('div');
  Object.assign(controls.style, { display: 'flex', gap: '8px', margin: '10px 0', flexWrap: 'wrap' });
  const scanButton = element('button', chapter ? '匹配本章题目' : '匹配当前试卷', controls);
  scanButton.id = 'jjfz-question-scan';
  const fillButton = element('button', '填写可靠答案（手动交卷）', controls);
  fillButton.id = 'jjfz-question-fill';
  for (const button of [scanButton, fillButton]) {
    button.type = 'button';
    Object.assign(button.style, { padding: '6px 10px', cursor: 'pointer' });
  }
  const message = element('p', `当前 ${count} 题。点击匹配后检查结果，网站倒计时继续生效，请及时核对和交卷。`);
  message.setAttribute('role', 'status');
  const list = element('div');
  Object.assign(list.style, { maxHeight: '300px', overflowY: 'auto', overflowWrap: 'anywhere' });
  document.body.append(panel);

  const labels = {
    exact: '可靠匹配', similar: '题干近似，仅供核对', missing: '未匹配，请手动处理',
    conflict: '答案冲突，请手动处理', 'options-changed': '选项发生变化，请手动核对', invalid: '题目结构异常',
    saved: '已保存，等待你交卷', answered: '已有作答，保留原答案', changed: '题目或作答已变化，请重新核对', failed: '保存未确认，请手动核对'
  };
  function setMessage(text) { message.textContent = text; }
  function isAnswered(question) { return question.type === 'fill' ? Boolean(question.answer) : question.selected.length > 0; }
  function fingerprint(question) {
    return JSON.stringify([question.index, question.qid, question.type, question.question, question.options]);
  }
  function chosen(question) { return question.type === 'fill' ? question.answer : [...question.selected].sort().join('|'); }
  function active() {
    if (location.href !== initialHref) throw Error('页面已切换，请在当前试卷重新匹配。');
  }
  function render() {
    list.replaceChildren();
    for (const row of rows) {
      const item = element('div', '', list);
      Object.assign(item.style, { padding: '8px 0', borderTop: '1px solid #e0e6eb' });
      const heading = element('button', `${row.question.index}. ${labels[row.state]}`, item);
      heading.type = 'button';
      heading.addEventListener('click', () => document.querySelectorAll('.exam_num_lists li')[row.question.index - 1]?.click());
      element('div', row.question.question, item);
      if (row.result.answers) element('div', '参考答案：' + row.result.answers.join('；'), item);
      if (row.result.status === 'similar') element('div', '相近题干：' + row.result.question, item);
    }
    scanButton.disabled = busy;
    mode.disabled = busy;
    fillButton.disabled = busy || mode.value !== 'manual' || !rows.some(row => row.state === 'exact');
  }
  function address(action, index) {
    const url = new URL(endpoint + '/' + action, page.origin);
    url.searchParams.set('stg', stage);
    if (chapter) url.searchParams.set('lesson_id', lesson);
    if (index) url.searchParams.set('i', String(index));
    return url;
  }
  async function readQuestion(index) {
    active();
    const url = address('get_question', index);
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw Error(`读取题目失败（HTTP ${response.status}）。`);
        break;
      } catch (error) {
        if (attempt) throw error;
        active();
      }
    }
    const html = await response.text();
    active();
    return parseQuestion(new DOMParser().parseFromString(html, 'text/html'), index);
  }
  async function scan() {
    if (busy) return;
    busy = true;
    rows = [];
    render();
    try {
      for (let index = 1; index <= count; index++) {
        setMessage(`正在匹配 ${index}/${count} 题。`);
        const question = await readQuestion(index);
        const result = match(question);
        rows.push({ question, result, state: isAnswered(question) ? 'answered' : result.status });
      }
      const reliable = rows.filter(row => row.result.status === 'exact').length;
      setMessage(`已匹配 ${count} 题：可靠 ${reliable}，待核对 ${count - reliable}。已有作答会保留。填写结束后请检查并在网站手动交卷。`);
    } catch (error) {
      rows = [];
      setMessage('匹配中断：' + error.message + ' 请重新匹配或手动做题。');
    } finally {
      busy = false;
      render();
    }
  }
  function updateVisible(question, result) {
    const root = document.querySelector('.exam_cont_left');
    if (!root) return;
    try {
      const visible = parseQuestion(root, question.index);
      if (fingerprint(visible) !== fingerprint(question)) return;
    } catch { return; }
    if (question.type === 'fill') root.querySelector('.summary_question').value = result.text;
    else for (const label of root.querySelectorAll('.answer_list label,.answer_list_box label')) {
      const input = label.querySelector('input');
      const selected = result.values.includes(input.value);
      input.checked = selected;
      label.classList.toggle('checked', selected);
      label.closest('li')?.classList.toggle('result_cut', selected);
    }
    document.getElementById(question.qid)?.classList.add('done');
  }
  async function fill() {
    if (busy || mode.value !== 'manual' || !rows.length) return;
    busy = true;
    render();
    let saved = 0;
    try {
      for (const row of rows) {
        if (row.state !== 'exact') continue;
        active();
        const question = await readQuestion(row.question.index);
        if (fingerprint(question) !== fingerprint(row.question) || touched.has(question.qid)) {
          row.state = 'changed';
          continue;
        }
        if (isAnswered(question) || chosen(question) !== chosen(row.question)) {
          row.state = 'answered';
          continue;
        }
        const result = match(question);
        if (result.status !== 'exact') { row.state = 'changed'; continue; }
        const token = document.querySelector('input[name="_xsrf"]')?.value;
        if (!token) throw Error('登录凭据已失效，请核对登录状态。');
        const fields = { stg: stage, i: String(question.index), qid: question.qid, answer: question.type === 'fill' ? result.text : result.values.join('|'), _xsrf: token };
        if (chapter) fields.lesson_id = lesson;
        row.state = 'failed';
        const response = await fetch(address('answer', question.index), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
          headers: { 'X-XSRFToken': token }, body: new URLSearchParams(fields)
        });
        if (!response.ok) throw Error(`保存失败（HTTP ${response.status}）。`);
        const reply = await response.json();
        active();
        if (Number(reply.code) !== 1) throw Error(reply.message || '网站未确认保存。');
        const stored = await readQuestion(question.index);
        const expected = question.type === 'fill' ? result.text : [...result.values].sort().join('|');
        if (fingerprint(stored) !== fingerprint(question) || chosen(stored) !== expected) throw Error('保存结果与预期不符。');
        row.state = 'saved';
        saved++;
        updateVisible(question, result);
        setMessage(`已确认保存 ${saved} 题。所有题目完成后由你手动交卷。`);
      }
      const pending = rows.filter(row => !['saved', 'answered'].includes(row.state)).length;
      setMessage(`已确认保存 ${saved} 题，保留已有作答 ${rows.filter(row => row.state === 'answered').length} 题，待处理 ${pending} 题。请核对答题卡，并在网站手动交卷。`);
    } catch (error) {
      setMessage(`已确认保存 ${saved} 题，填写已停止：${error.message} 请核对答题卡后手动交卷。`);
    } finally {
      busy = false;
      render();
    }
  }
  for (const event of ['input', 'change']) document.addEventListener(event, e => {
    if (!e.target.closest?.('.exam_cont_left')) return;
    const qid = e.target.getAttribute('qid') ?? e.target.closest('[qid]')?.getAttribute('qid');
    if (qid) touched.add(qid);
  }, true);
  mode.addEventListener('change', () => { GM_setValue(preference, mode.value); render(); });
  scanButton.addEventListener('click', () => { void scan(); });
  fillButton.addEventListener('click', () => { void fill(); });
  GM_registerMenuCommand('匹配当前试卷（每章手动交卷）', () => { panel.open = true; return scan(); });
  GM_registerMenuCommand('填写可靠答案（每章手动交卷）', () => { panel.open = true; return fill(); });
  render();
}


runQuestionAssistant([{"type":"single","question":"下列历史题材的影片所再现的史实，按其先后顺序排列正确的是（ ）。①《辛亥革命》②《鸦片战争》③《开国大典》","options":["②①③","①②③","③②①","②③①"],"answers":["②①③"]},{"type":"single","question":"1992年10月12日至18日，中共第十四次全国代表大会在北京召开。江泽民同志在会上作了（ ）的报告。大会通过了《中国共产党章程（修正案）》，将建设有中国特色的社会主义的理论和党的基本路线写进党章。","options":["《加快改革开放和现代化建设步伐，夺取有中国特色社会主义事业的更大胜利》","《沿着有中国特色社会主义道路前进》","《高举邓小平理论伟大旗帜，把建设有中国特色社会主义事业推向二十一世纪》","《全面开创社会主义现代化建设的新局面》"],"answers":["《加快改革开放和现代化建设步伐，夺取有中国特色社会主义事业的更大胜利》"]},{"type":"single","question":"抗日战争时期，中国共产党领导的各抗日根据地实行的政权形式是（ ）。","options":["联合政府","“三三制”政权","共产党一党执政","国共合作政府"],"answers":["“三三制”政权"]},{"type":"single","question":"1949年4月23日，南京的解放标志着（ ）。","options":["中国民主革命取得彻底胜利","人民解放战争结束","新民主主义革命的终结和社会主义革命的开始","统治中国大陆22年的国民党政府的覆灭"],"answers":["统治中国大陆22年的国民党政府的覆灭"]},{"type":"single","question":"由领导人错误发动，给党、国家和人民造成新中国成立以来最严重挫折和损失的“文化大革命”发生的时间是（ ）。","options":["1960年5月至1970年10月","1963年9月至1973年9月","1966年5月至1976年10月","1966年5月至1976年4月"],"answers":["1966年5月至1976年10月"]},{"type":"single","question":"一九一九年五四运动标志着中国（ ）的开端。","options":["旧民主主义革命","新民主主义革命","社会主义革命","工农革命"],"answers":["新民主主义革命"]},{"type":"single","question":"1948年的最后一天，蒋介石在日记中写道：“本月忧患最深……各方告急与失败之报，几如雪花飞来，……一切唯听天命而已。”蒋介石这种心态主要是因为（ ）。","options":["刘邓大军挺进大别山，揭开了战略反攻的序幕","人民解放军在战略决战中取得节节胜利","人民解放军和平解放了北平","毛泽东和朱德下达了渡江战役的命令"],"answers":["人民解放军在战略决战中取得节节胜利"]},{"type":"single","question":"在解放战争时期的“三大战役”中，最先打响的是（ ）。","options":["上党战役","辽沈战役","平津战役","淮海战役"],"answers":["辽沈战役"]},{"type":"single","question":"1927年8月7日，中国共产党历史上著名的八七会议召开于（ ）。","options":["上海","广州","汉口","北京"],"answers":["汉口"]},{"type":"single","question":"坚持党中央集中统一领导，确立和维护党的（ ），是全党全国各族人民的共同愿望，是推进全面从严治党、提高党的创造力凝聚力战斗力的迫切要求，是保持党和国家事业发展正确方向的根本保证。","options":["领导核心","领导权威","领导地位","领导能力"],"answers":["领导核心"]},{"type":"multiple","question":"国共两党政权十年对峙时期，中国社会的矛盾有（ ）。","options":["中华民族与日本帝国主义的矛盾","官僚资产阶级与人民大众的矛盾","农民阶级与地主阶级的矛盾","国民党爱国将领与蒋介石的矛盾"],"answers":["中华民族与日本帝国主义的矛盾","官僚资产阶级与人民大众的矛盾","农民阶级与地主阶级的矛盾","国民党爱国将领与蒋介石的矛盾"]},{"type":"multiple","question":"在社会主义现代化建设的新时期，中国共产党的统一战线政策与之前的相比（ ）。","options":["增加了多党合作的内容","与民主党派的关系更加密切","包含的社会力量更加广泛","建立了民主协商的政治制度"],"answers":["与民主党派的关系更加密切","包含的社会力量更加广泛"]},{"type":"multiple","question":"“八七”会议同遵义会议的相同点是（ ）。","options":["从政治上、军事上、思想上全力纠正错误","毛泽东参加会议并且提出正确主张","在危机之时挽救了党","党独立自主解决自己问题的开始"],"answers":["毛泽东参加会议并且提出正确主张","在危机之时挽救了党"]},{"type":"multiple","question":"中共十一届三中全会后，邓小平领导党和人民实现了若干重要转变，即（ ）。","options":["从“以阶级斗争为纲”转到以发展生产力为中心","从固守成法到各方面的改革","从封闭半封闭到对外开放","从基本上是苏联模式的社会主义转到建设有中国特色的社会主义"],"answers":["从“以阶级斗争为纲”转到以发展生产力为中心","从固守成法到各方面的改革","从封闭半封闭到对外开放","从基本上是苏联模式的社会主义转到建设有中国特色的社会主义"]},{"type":"multiple","question":"近一个世纪以来，我国先后发生三次伟大革命，下列属于三次革命的是（ ）。","options":["洪秀全领导的太平天国农民革命","孙中山先生领导的资产阶级辛亥革命","中国共产党领导的新民主主义革命和社会主义革命","中国共产党领导的改革开放这场新的伟大革命"],"answers":["孙中山先生领导的资产阶级辛亥革命","中国共产党领导的新民主主义革命和社会主义革命","中国共产党领导的改革开放这场新的伟大革命"]},{"type":"boolean","question":"中国无产阶级作为独立的政治力量第一次登上历史舞台是在五四运动中。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"中共十五大的主题是：高举邓小平理论伟大旗帜，全面贯彻“三个代表”重要思想。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"中共十二大首次明确提出的命题是建设有中国特色的社会主义。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"中国特色社会主义制度更加成熟更加定型，国家治理体系和治理能力现代化水平明显提高。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"第一届全国人民代表大会选举的人大常委会委员长是董必武。","options":["正确","错误"],"answers":["错误"]},{"type":"single","question":"“人类社会正在发生根本的变革，只有工人阶级才能领导”。“根本的变革”是指（ ）。","options":["从封建社会到资产阶级社会","从资产阶级社会到无产阶级社会","从资产阶级社会到社会主义社会","从阶级社会到没有阶级的社会"],"answers":["从阶级社会到没有阶级的社会"]},{"type":"single","question":"“党是中国人民和中华民族的先锋队”，深刻地反映了党的（ ）。","options":["阶级本质","群众基础","历史特性","超阶级性"],"answers":["群众基础"]},{"type":"single","question":"（ ）是决定一个政党、一个政权盛衰的根本因素。","options":["执政能力","领导水平","人心向背","群众基础"],"answers":["人心向背"]},{"type":"single","question":"我们党必须坚持把（ ）作为一切工作的出发点和归宿。","options":["人民的根本利益","党的群众基础","党的执政能力","工人阶级力量"],"answers":["人民的根本利益"]},{"type":"single","question":"为什么只有中国共产党才能成为中国特色社会主义事业的领导核心（ ）。","options":["党的性质决定的","人民的选择","历史的结果","以上都是"],"answers":["以上都是"]},{"type":"single","question":"要判断一个政党是无产阶级政党还是资产阶级政党，最根本的依据是什么？（ ）。","options":["是否全心全意为人民服务","是否命名为共产党","是否接受共产国际的领导","是否领导工人运动"],"answers":["是否全心全意为人民服务"]},{"type":"single","question":"中国共产党从成立时起，就把（ ）作为自己的最高原则。","options":["为人民服务","代表先进生产力的发展要求","保持先进性和纯洁性","坚持马克思主义指导"],"answers":["为人民服务"]},{"type":"single","question":"中国共产党的宗旨是（ ）。","options":["实事求是","与时俱进","全心全意为人民服务","解放思想"],"answers":["全心全意为人民服务"]},{"type":"single","question":"我们党是（ ）的先锋队，全心全意依靠工人阶级是党和国家的一条根本方针。","options":["劳动人民","中华民族","工人阶级","中国人民"],"answers":["工人阶级"]},{"type":"single","question":"（ ），就是要牢记我们党肩负的实现中华民族伟大复兴的历史使命，勇于担当负责，积极主动作为，保持斗争精神，敢于直面风险挑战，以坚忍不拔的意志和无私无畏的勇气战胜前进道路上的一切艰难险阻。","options":["守初心","担使命","筑梦想","守信念"],"answers":["担使命"]},{"type":"multiple","question":"坚持中国共产党领导的原因是（ ）。","options":["中国特色社会主义最本质的特征是中国共产党领导","中国特色社会主义制度的最大优势是中国共产党领导","这是党和国家的根本所在、命脉所在，是全国各族人民的利益所在、幸福所在","中国共产党的领导不是自封的，是历史和人民的选择"],"answers":["中国特色社会主义最本质的特征是中国共产党领导","中国特色社会主义制度的最大优势是中国共产党领导","这是党和国家的根本所在、命脉所在，是全国各族人民的利益所在、幸福所在","中国共产党的领导不是自封的，是历史和人民的选择"]},{"type":"multiple","question":"党的十七届四中全会把建设马克思主义学习型政党作为重大而紧迫的战略任务提出来，是从当前的世情、国情、党情出发，进一步动员全党抓住机遇、应对挑战、共克时艰的必然要求和重大举措。建设马克思主义学习型政党（ ）。","options":["是保持党的先进性的要求","有利于党始终代表中国先进文化的前进方向","有利于党坚定共产主义和中国特色社会主义的理想信念","是加强党的先进性建设的唯一途径"],"answers":["是保持党的先进性的要求","有利于党始终代表中国先进文化的前进方向","有利于党坚定共产主义和中国特色社会主义的理想信念"]},{"type":"multiple","question":"在党的建设中贯彻全心全意为人民服务的宗旨，合适的做法是（ ）。","options":["党员始终是来自劳动人民的普通一员","党员不得谋求除了法律和政策规定范围内的个人利益以外的任何私利","一切工作都得从人民利益出发","党员的个人利益无条件服从党和人民利益"],"answers":["党员始终是来自劳动人民的普通一员","党员不得谋求除了法律和政策规定范围内的个人利益以外的任何私利","一切工作都得从人民利益出发","党员的个人利益无条件服从党和人民利益"]},{"type":"multiple","question":"党在新时代要维持自身的领导地位，必须（ ）。","options":["坚持改革创新","站在时代的前列","紧密联系群众","加强党的自身建设"],"answers":["坚持改革创新","站在时代的前列","紧密联系群众","加强党的自身建设"]},{"type":"multiple","question":"毛泽东思想的活的灵魂，即（）。","options":["人民民主","实事求是","群众路线","独立自主"],"answers":["实事求是","群众路线","独立自主"]},{"type":"boolean","question":"我们要坚持绿水青山就是金山银山的理念。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党除了工人阶级和最广大人民群众的利益，没有自己特殊的利益。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"在十八届中共中央政治局常委同中外记者见面时，习近平总书记说：“人民对美好生活的向往，就是我们的奋斗目标。”","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"允许其他社会阶层中的先进分子入党，意味着党员成分的多样性。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"不坚持社会主义，不改革开放，不发展经济，不改善人民生活，只能是死路一条。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"坚持（ ），巩固军政军民团结。","options":["拥军优属、拥政爱民","互相依存、共驻共建","共同发展、互相促进","军民一体、同心同德"],"answers":["拥军优属、拥政爱民"]},{"type":"single","question":"邓小平指出，从我们党的历史来看，我们全党成熟的标志是（ ），那是在一九四五年。","options":["第七次全国代表大会","第八次全国代表大会","第九次全国代表大会","第十次全国代表大会"],"answers":["第七次全国代表大会"]},{"type":"single","question":"1943年毛泽东为党中央写的《关于领导方法的若干问题》中没有的是（ ）。","options":["科学阐释了群众路线所含问题和实施步骤","分析从群众中来到群众中去的必要性","讲解了群众路线领导方法的全过程和各个环节","指出了目前指导方法的缺陷和问题"],"answers":["指出了目前指导方法的缺陷和问题"]},{"type":"single","question":"我们要立下愚公移山志，咬定目标、苦干实干，坚决打赢脱贫攻坚战，确保到（ ）所有贫困地区和贫困人口一道迈入全面小康社会。","options":["2019年","2020年","2025年","2030年"],"answers":["2020年"]},{"type":"single","question":"科学发展观是发展中国特色社会主义必须坚持和贯彻的（ ）","options":["基本国策","指导思想","根本方针","基本标准"],"answers":["指导思想"]},{"type":"single","question":"“长征是宣言书，长征是宣传队，长征是播种机。”这句话出自毛泽东的（ ）。","options":["《论反对日本帝国主义的策略》","《中国革命战争的战略问题》","《星星之火可以燎原》","《论十大关系》"],"answers":["《论反对日本帝国主义的策略》"]},{"type":"single","question":"邓小平理论阐明了（ ）的基本问题。","options":["在中国建设社会主义、巩固和发展社会主义","什么是社会主义、怎样建设社会主义","实现什么样的发展、怎样发展","怎样建设中国特色社会主义市场经济"],"answers":["在中国建设社会主义、巩固和发展社会主义"]},{"type":"single","question":"有人批评道:“两个先锋队”理论是对马克思主义的背叛。这种说法错在（ ）。","options":["教条地强调了马克思主义的国家学说","将党的阶级性和人民性对立起来","忽视了中华民族的利益","错误理解了党的先进性"],"answers":["将党的阶级性和人民性对立起来"]},{"type":"single","question":"关于“三个代表”之间关系的说法，错误的是（ ）。","options":["人民群众既是先进生产力和先进文化的创造者，又是其成果的享有者","实现最广大人民根本利益是发展先进生产力和先进文化的手段和途径","发展先进生产力和先进文化是实现最广大人民根本利益的基础和前提","增强国家的经济实力，才能为发展先进文化提供物质基础"],"answers":["实现最广大人民根本利益是发展先进生产力和先进文化的手段和途径"]},{"type":"single","question":"在新的时代条件下，我们要进行伟大斗争、建设伟大工程、推进伟大事业、实现伟大梦想，仍然需要保持和发扬马克思主义政党（ ）的理论品格，勇于推进实践基础上的理论创新。","options":["理论联系实际","实事求是","与时俱进","改革创新"],"answers":["与时俱进"]},{"type":"multiple","question":"下列关于社会主义生态文明建设的说法，正确的是（ ）。","options":["树立尊重自然、顺应自然、保护自然的生态文明理念","增强绿水青山就是金山银山的意识","坚持节约优先、保护优先、自然恢复为主的方针","坚持节约资源和保护环境的基本国策"],"answers":["树立尊重自然、顺应自然、保护自然的生态文明理念","增强绿水青山就是金山银山的意识","坚持节约优先、保护优先、自然恢复为主的方针","坚持节约资源和保护环境的基本国策"]},{"type":"multiple","question":"关于毛泽东思想提出过程的说法，正确的是（ ）。","options":["刘少奇第一次提出了“毛泽东思想”","王稼祥提出了毛泽东思想作为一个科学概念","七大党章规定“毛泽东思想”为党的指导思想","首次提出毛泽东思想的正式文件是《论党》"],"answers":["王稼祥提出了毛泽东思想作为一个科学概念","七大党章规定“毛泽东思想”为党的指导思想","首次提出毛泽东思想的正式文件是《论党》"]},{"type":"multiple","question":"十六大报告指出:“贯彻‘三个代表’重要思想，关键是坚持与是俱进”，“必须使全党保持与时俱进的精神状态，不断开拓马克思主义理论发展的新境界。”这是因为（ ）。","options":["与时俱进是辨证唯物主义的根本要求","与时俱进是马克思主义的理论品质","与时俱进是我们党坚持先进性、增强创造力的决定性因素","能否做到与时俱进，决定着党和国家的前途党和命运"],"answers":["与时俱进是辨证唯物主义的根本要求","与时俱进是马克思主义的理论品质","与时俱进是我们党坚持先进性、增强创造力的决定性因素","能否做到与时俱进，决定着党和国家的前途党和命运"]},{"type":"multiple","question":"毛泽东同志把（ ）运用于无产阶级政党的全部工作，在中国革命和建设的长期艰苦斗争中形成了具有中国共产党人鲜明特色的立场、观点、方法。","options":["辩证唯物主义","辩证唯心主义","历史唯物主义","历史唯心主义"],"answers":["辩证唯物主义","历史唯物主义"]},{"type":"multiple","question":"“四有公民”是指（ ）。","options":["有理想","有道德","有文化","有纪律"],"answers":["有理想","有道德","有文化","有纪律"]},{"type":"boolean","question":"我们党之所以历经百年而风华正茂、饱经磨难而生生不息，就是凭着那么一股革命加拼命的强大精神。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"只有强调从思想上建党，才能保持党的先进性和纯洁性，从而不断增强党在社会上的影响力和凝聚力。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"在20世纪60年代初，毛泽东在读完苏联《政治经济学教科书》后指出，在我们这样的国家，完成社会主义建设是一个艰巨任务，建成社会主义不要讲得过早了。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的十七大决定，把科学发展观写进党章并作为党长期坚持的指导思想。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"强调“三个代表”要求，不仅是我们党的立党之本、执政之基、力量之源，也是新世纪全面推进党的建设，不断推进理论创新、制度创新和科技创新，不断夺取建设有中国特色社会主义事业新胜利的根本要求。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"党在社会主义初级阶段的基本路线的核心内容是（ ）。","options":["“一个中心，两个基本点”","自力更生，艰苦创业","把我国建设富强、民主、文明的社会主义现代化国家","解放思想实事求是"],"answers":["“一个中心，两个基本点”"]},{"type":"single","question":"党在社会主义初级阶段“一个中心、两个基本点”的基本路线提出于（ ）。","options":["党的十二大","党的十三大","党的十四大","党的十五大"],"answers":["党的十三大"]},{"type":"single","question":"党在社会主义建设时期坚持的中心任务是（ ）。","options":["政治斗争","经济建设","对外关系","武装斗争"],"answers":["经济建设"]},{"type":"single","question":"2012年10月29日，习总书记带领新的中央领导集体参观复兴之路的展览，在参观过程中，习总书记作了重要讲话，把两个百年目标凝结为一句话:（ ）。","options":["最终实现共产主义","实现中华民族伟大复兴的中国梦","进入发达国家行列","成为整个世界经济体的领头羊"],"answers":["实现中华民族伟大复兴的中国梦"]},{"type":"single","question":"我国所制定的经济发展的目标中指出，本世纪中叶人均国民生产总值达到（ ）水平。","options":["小康","初步发达国家","中等发达国家","发达国家"],"answers":["中等发达国家"]},{"type":"single","question":"下列不属于构建社会主义和谐社会总要求的是（ ）。","options":["民主法治","公平正义","安定有序","文明礼貌"],"answers":["文明礼貌"]},{"type":"single","question":"十九大党章增写了必须坚持以（ ）为中心的发展思想。","options":["创新","科技","人民","人民群众"],"answers":["人民"]},{"type":"single","question":"党章总纲指出，中国共产党在（ ）的基本路线是领导和团结全国各族人民，以经济建设为中心，坚持四项基本原则，坚持改革开放，自力更生，艰苦创业，为把我国建设成为富强民主文明和谐美丽的社会主义现代化强国而奋斗。","options":["社会主义初级阶段","改革开放和社会主义现代化建设阶段","全面建设小康社会阶段","建设中国特色社会主义"],"answers":["社会主义初级阶段"]},{"type":"single","question":"建设社会主义生态文明，要树立尊重自然、（ ）、保护自然的生态文明理念。","options":["利用自然","崇尚自然","顺应自然","顺从自然"],"answers":["顺应自然"]},{"type":"single","question":"经济和社会发展的战略目标是，到建党一百年时，（ ）。","options":["建成更高水平的小康社会","基本实现现代化","全面建成小康社会","建成惠及几十亿人口的更高水平的小康社会"],"answers":["全面建成小康社会"]},{"type":"multiple","question":"全党要坚持党的基本理论、基本路线、基本方略不动摇，坚定（），坚持独立自主、自力更生，坚持道不变、志不改，既不走封闭僵化的老路，也不走改旗易帜的邪路，坚定不移走好自己的路，心无旁骛做好自己的事，坚持把国家和民族发展放在自己力量的基点上，坚持把中国发展进步的命运牢牢掌握在自己手中。","options":["道路自信","理论自信","制度自信","文化自信"],"answers":["道路自信","理论自信","制度自信","文化自信"]},{"type":"multiple","question":"四项基本原则包括（ ）。","options":["坚持社会主义道路","坚持人民民主专政","坚持中国共产党领导","坚持马克思列宁主义、毛泽东思想"],"answers":["坚持社会主义道路","坚持人民民主专政","坚持中国共产党领导","坚持马克思列宁主义、毛泽东思想"]},{"type":"multiple","question":"改革开放以来，中国共产党弘扬的优良传统包括（）。","options":["崇尚学习，建设学习型政党","勇于修正错误，总结经验“常态化”","形成了最根本的理论和实践创造","紧密联系群众，把人民放在“最高位置”"],"answers":["崇尚学习，建设学习型政党","勇于修正错误，总结经验“常态化”","形成了最根本的理论和实践创造","紧密联系群众，把人民放在“最高位置”"]},{"type":"multiple","question":"走过百年奋斗历程的中国共产党在革命性锻造中更加坚强有力，中国人民的前进动力更加强大、奋斗精神更加昂扬、必胜信念更加坚定，我国发展具备了（），实现中华民族伟大复兴进入了不可逆转的历史进程，中国特色社会主义展现出蓬勃生机。","options":["更为坚实的物质基础","更为完善的制度保证","更为主动的精神力量","更为饱满的斗争精神"],"answers":["更为坚实的物质基础","更为完善的制度保证","更为主动的精神力量"]},{"type":"multiple","question":"下列属于中国共产党在艰辛探索中形成的优良传统的是（）。","options":["全心全意为人民服务","艰苦奋斗","调查研究","思想政治工作"],"answers":["全心全意为人民服务","艰苦奋斗","调查研究","思想政治工作"]},{"type":"boolean","question":"2023年第11期《求是》杂志发表习近平总书记的重要文章《中国式现代化是中国共产党领导的社会主义现代化》，这是习近平总书记2023年2月7日在新进中央委员会的委员、候补委员和省部级主要领导干部学习贯彻习近平新时代中国特色社会主义思想和党的二十大精神研讨班上讲话的一部分。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的二十大，是在全党全国各族人民迈上全面建设社会主义现代化国家新征程、向第二个百年奋斗目标进军的关键时刻召开的一次十分重要的大会，是一次高举旗帜、凝聚力量、团结奋进的大会。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"中国共产党和中国人民以英勇顽强的奋斗向世界庄严宣告，中华民族迎来了从站起来、富起来到强起来的伟大飞跃，实现中华民族伟大复兴进入了不可逆转的历史进程！","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"习近平总书记曾在不同场合多次强调，全面建成小康社会，一个不能少；共同富裕路上，一个不能掉队。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"走自己的路，是党百年奋斗得出的历史结论。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"从二〇三五年到本世纪中叶，在基本实现现代化的基础上，再奋斗十五年，把我国建成（ ）的社会主义现代化强国。","options":["富强民主文明和谐","国际影响力领先","富强民主文明和谐美丽","综合国力领先"],"answers":["富强民主文明和谐美丽"]},{"type":"single","question":"党的二十大报告指出，党和国家事业取得历史性成就、发生历史性变革，推动我国迈上全面建设社会主义现代化国家（ ）。","options":["新旅途","新道路","新长征","新征程"],"answers":["新征程"]},{"type":"single","question":"党的二十大报告指出：未来（ ）是全面建设社会主义现代化国家开局起步的关键时期。","options":["3年","5年","10年","20年"],"answers":["5年"]},{"type":"single","question":"党的二十大报告指出，我们必须更好发挥法治固根本、稳预期、利长远的保障作用，在法治（ ）上全面建设社会主义现代化国家。","options":["道路","方向","轨道","途径"],"answers":["轨道"]},{"type":"single","question":"二十大党章规定：党员必须履行增强“四个意识”、坚定“四个自信”、做到“两个维护”，贯彻执行党的（ ）和各项方针、政策，带头参加改革开放和社会主义现代化建设，带动群众为经济发展和社会进步艰苦奋斗，在生产、工作、学习和社会生活中起先锋模范作用。","options":["基本文件","基本路线","基本纲领","基本制度"],"answers":["基本路线"]},{"type":"single","question":"中国式现代化，是中国共产党领导的社会主义现代化，既有各国现代化的共同特征，更有基于自己国情的（ ）。","options":["中国特色","中国理念","中国思路","中国方案"],"answers":["中国特色"]},{"type":"single","question":"习近平在党史学习教育动员大会上指出，全党同志要做到（ ）、（ ）、学史崇德、学史力行，学党史、悟思想、办实事、开新局，以昂扬姿态奋力开启全面建设社会主义现代化国家新征程，以优异成绩迎接建党一百周年。","options":["知史爱党、知史爱国","学史明理、学史增信","知史明理、知史增信","学史爱党、学史爱国"],"answers":["学史明理、学史增信"]},{"type":"single","question":"2022年1月18日，习近平在十九届中央纪委六次全会上指出，2021年是中国共产党成立一百周年。党中央坚定不移推进全面从严治党，为全面建设社会主义现代化国家开好局、起好步提供了有力（）。","options":["政治制度","政治保障","法律制度","法律保障"],"answers":["政治保障"]},{"type":"single","question":"从全面建成小康社会到基本实现现代化，再到全面建成社会主义现代化强国，是（ ）中国特色社会主义发展的战略安排。","options":["新时期","新阶段","新时代","新征程"],"answers":["新时代"]},{"type":"single","question":"全面建成社会主义现代化强国，总的战略安排是分两步走：从二〇二〇年到（）基本实现社会主义现代化。从二〇三五年到本世纪中叶把我国建成富强民主文明和谐美丽的社会主义现代化强国。","options":["二〇三〇年","二〇三五年","二〇四〇年","二〇四五年"],"answers":["二〇三五年"]},{"type":"multiple","question":"从二〇二〇年到二〇三五年，在全面建成小康社会的基础上，再奋斗十五年，基本实现社会主义现代化。到那时，（ ），全体人民共同富裕迈出坚实步伐。","options":["人民生活更为宽裕","中等收入群体比例明显提高","城乡区域发展差距和居民生活水平差距显著缩小","基本公共服务均等化基本实现"],"answers":["人民生活更为宽裕","中等收入群体比例明显提高","城乡区域发展差距和居民生活水平差距显著缩小","基本公共服务均等化基本实现"]},{"type":"multiple","question":"要实现我国社会主义现代化建设和中华民族伟大复兴的宏伟目标，必须牢牢把握社会主义先进文化的前进方向，努力建设中国特色社会主义文化。中国特色社会主义文化（ ）。","options":["是我国社会主义现代化建设的重要内容","是凝聚和激励全国各族人民的重要力量","是综合国力的重要标志","为现代化建设提供智力支持、精力动力和思想保证"],"answers":["是我国社会主义现代化建设的重要内容","是凝聚和激励全国各族人民的重要力量","是综合国力的重要标志","为现代化建设提供智力支持、精力动力和思想保证"]},{"type":"multiple","question":"下列属于改革开放和社会主义现代化建设新时期中国共产党人的精神的是（）。","options":["改革开放精神","特区精神","抗洪精神","抗击“非典”精神"],"answers":["改革开放精神","特区精神","抗洪精神","抗击“非典”精神"]},{"type":"multiple","question":"全面建成社会主义现代化强国，总的战略安排是分两步走：从二〇二〇年到二〇三五年基本实现社会主义现代化；从二〇三五年到本世纪中叶把我国建成（ ）的社会主义现代化强国。","options":["富强","民主","文明","和谐","美丽"],"answers":["富强","民主","文明","和谐","美丽"]},{"type":"multiple","question":"人民民主是社会主义的生命,是全面建设社会主义现代化国家的应有之义。全过程人民民主是社会主义民主政治的本质属性,是（ ）的民主。","options":["最广泛","最真实","最管用","最有效"],"answers":["最广泛","最真实","最管用"]},{"type":"boolean","question":"改革开放和社会主义现代化建设新时期，我国推进了中华民族从站起来到富起来的伟大飞跃。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"绿色发展理念，体现了我们党对经济社会发展规律认识的深化，对于建设美丽中国、全面建设社会主义现代化国家具有重大的理论意义和现实意义。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"物质富足、精神富有是社会主义现代化的根本要求。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"没有坚实的物质基础，就不可能全面建成社会主义现代化强国。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"党的二十大报告指出，全面建设社会主义现代化国家，最艰巨最繁重的任务仍然在农村。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"在党内组织秘密集团或者组织其他分裂党的活动的，给予（ ）处分。","options":["严重警告","撤销党内职务","留党察看","开除党籍"],"answers":["开除党籍"]},{"type":"single","question":"党的各项建设的重要保证是（ ）。","options":["思想建设","政治建设","制度建设","组织建设"],"answers":["制度建设"]},{"type":"single","question":"如果党员对党组织的处分不服，可以（ ）。","options":["拒不接受","向党组织申诉","秘密上报","逃跑躲避"],"answers":["向党组织申诉"]},{"type":"single","question":"党的十八届六中全会提出，全体党员、干部特别是高级干部必须增强党的意识，时刻牢记自己第一身份是（）。","options":["干部","领导","党员","群众"],"answers":["党员"]},{"type":"single","question":"党的各级纪律检查委员会要受理党员的（ ）。","options":["控告和申诉","倡议和批评","意见和建议","批评和质询"],"answers":["控告和申诉"]},{"type":"single","question":"党的十八届六中全会提出，党内民主是党的生命，是党内政治生活积极健康的重要（）。","options":["基础","依据","保障","标准"],"answers":["基础"]},{"type":"single","question":"对地方各级党的委员会委员、候补委员，给以警告、严重警告处分，应由上一级纪律检查委员会批准，并报它的同级党的委员会（ ）。","options":["审议","批准","备案","知情"],"answers":["备案"]},{"type":"single","question":"（ ）是维护党的团结统一、完成党的任务的保证。","options":["党的纪律","党的路线","党的政策","党的方针"],"answers":["党的纪律"]},{"type":"single","question":"受到留党察看处分的党员，恢复党员权利后（ ）内，不得在党内担任和向党外组织推荐担任与其原任职务相当或者高于其原任职务的职务。","options":["半年","一年","二年","三年"],"answers":["二年"]},{"type":"single","question":"“两个务必”是毛泽东在（）上提出来的。","options":["中共六届六中全会","中共七届三中全会","中共七届二中全会","中共六届五中全会"],"answers":["中共七届二中全会"]},{"type":"multiple","question":"下列属于“狱中八条意见”的内容的有（ ）。","options":["防止领导成员腐化","加强党内教育和实际斗争的锻炼","不要理想主义，对上级也不要迷信","切勿轻视敌人"],"answers":["防止领导成员腐化","加强党内教育和实际斗争的锻炼","不要理想主义，对上级也不要迷信","切勿轻视敌人"]},{"type":"multiple","question":"工作中不敢斗争、不愿担当，面对重大矛盾冲突、危机困难临阵退缩，造成不良影响或者严重后果的，给予（ ）或者（ ）处分。","options":["警告","严重警告","撤销党内职务","留党察看"],"answers":["警告","严重警告"]},{"type":"multiple","question":"违反有关规定取得、持有、实际使用运动健身卡、会所和俱乐部会员卡、高尔夫球卡等各种消费卡（券），或者违反有关规定出入私人会所，情节较重的，给予（ ）或者（ ）处分。","options":["警告","严重警告","撤销党内职务","留党察看"],"answers":["警告","严重警告"]},{"type":"multiple","question":"预备党员违犯党纪，情节较轻，可以保留预备党员资格的，党组织应当对其（ ）。","options":["限期改正","批评教育","延长预备期","取消其预备党员资格"],"answers":["批评教育","延长预备期"]},{"type":"multiple","question":"《中国共产党纪律处分条例》规定，不按照有关规定向组织请示、报告重大事项，对直接责任者和领导责任者，情节较重的，给予（ ）或者（ ）处分。","options":["警告","严重警告","撤销党内职务","留党察看"],"answers":["警告","严重警告"]},{"type":"boolean","question":"党的基层委员会是设立纪律检查委员会，还是设立纪律检查委员，由它自己根据具体情况决定。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"党的地方各级纪律检查委员会全体会议，选举常务委员会和书记、副书记，并报同级党的委员会批准。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"群众纪律的本质在于践行党全心全意为人民服务的宗旨、维护和发展群众利益。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"纪律是刚性的规矩，一些未明文列入纪律的规矩是自我约束的纪律。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党员经过留党察看，确已改正错误的，应当恢复其党员的权利；坚持错误不改的，应当延长留党察看时间。","options":["正确","错误"],"answers":["错误"]},{"type":"single","question":"党的各级领导机关，对同下级组织有关的重要问题作出决定时，在通常情况下，要征求（ ）的意见。","options":["下级组织","上级组织","委员会","代表大会"],"answers":["下级组织"]},{"type":"single","question":"在党的全国代表大会闭会期间，（ ）执行全国代表大会的决议，领导党的全部工作，对外代表中国共产党。","options":["党的中央委员会","党的中央书记处","党的中央政治局","党的中央军事委员会"],"answers":["党的中央委员会"]},{"type":"single","question":"国有企业党委（党组）发挥（ ）作用，把方向、管大局、保落实，依照规定讨论和决定企业重大事项。","options":["政治核心","领导","领导核心","组织核心"],"answers":["领导"]},{"type":"single","question":"实行党委领导下的行政领导人负责制的事业单位中党的基层组织，对重大问题进行讨论和（ ），同时保证行政领导人充分行使自己的职权。","options":["提出意见和建议","作出决定","参与决策","给出指导"],"answers":["作出决定"]},{"type":"single","question":"在党的地方各级代表大会和基层代表大会闭会期间，上级党的组织认为有必要时，可以（ ）或者指派下级党组织的负责人。","options":["调动","巡视","罢免","督查"],"answers":["调动"]},{"type":"single","question":"2023年，全国组织工作会议首次正式提出和系统阐述“习近平总书记关于（）的重要思想”。","options":["做好新时代党的统一战线工作","网络强国","党的建设","自我革命"],"answers":["党的建设"]},{"type":"single","question":"党的全国代表会议的职权之一：调整和增选中央委员及候补中央委员的数额，不得超过党的全国代表大会选出的中央委员及候补中央委员各自总数的（ ）。","options":["三分之一","四分之一","五分之一","十分之一"],"answers":["五分之一"]},{"type":"single","question":"《党章》规定，每个党员，不论职务高低，都必须编入党的（ ），参加党的组织生活，接受党内外群众的监督。","options":["一个支部、小组","一个支部或其他特定组织","小组或其他特定组织","一个支部、小组或其他特定组织"],"answers":["一个支部、小组或其他特定组织"]},{"type":"single","question":"习近平总书记强调，办好中国的事情，关键在党，关键在人，关键在（）。","options":["人才","英才","贤才","精英"],"answers":["人才"]},{"type":"single","question":"社会组织中党的基层组织，宣传和执行党的路线、方针、政策，（ ）工会、共青团等群团组织，教育管理党员，引领服务群众，推动事业发展。","options":["领导","引导","管理","指导"],"answers":["领导"]},{"type":"multiple","question":"下列选项中，属于党的全国代表大会的职权的有（ ）。","options":["听取和审查中央委员会的报告","修改党的章程","讨论并决定党的重大问题","选举中央委员会"],"answers":["听取和审查中央委员会的报告","修改党的章程","讨论并决定党的重大问题","选举中央委员会"]},{"type":"multiple","question":"党的地方各级代表大会的职权有（ ）。","options":["听取和审查同级委员会的报告","审查同级纪律检查委员会的报告","讨论本地区范围内的重大问题并作出决议","选举同级党的委员会，选举同级党的纪律检查委员会"],"answers":["听取和审查同级委员会的报告","审查同级纪律检查委员会的报告","讨论本地区范围内的重大问题并作出决议","选举同级党的委员会，选举同级党的纪律检查委员会"]},{"type":"multiple","question":"凡属重大问题都要按照（ ）的原则，由党的委员集体讨论，作出决定。","options":["集体领导","民主集中","个别酝酿","会议决定"],"answers":["集体领导","民主集中","个别酝酿","会议决定"]},{"type":"multiple","question":"以下由党的全国代表大会选举产生的是（ ）。","options":["中央政治局","中央书记处","中央委员会","中央纪律检查委员会"],"answers":["中央委员会","中央纪律检查委员会"]},{"type":"multiple","question":"百年变局主要体现在哪些方面？（）","options":["新格局","新模式","新工业革命","新全局问题"],"answers":["新格局","新模式","新工业革命","新全局问题"]},{"type":"boolean","question":"实现中华民族伟大复兴的中国梦，需要广泛汇聚团结奋斗的正能量。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党员人数较多或者党员工作地、居住地比较分散的党支部，应当按照便于组织开展活动原则，划分若干党小组。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的基层组织要突出政治功能。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的地方各级代表大会由上级党的委员会召集。在特殊情况下，可以提前或延期举行。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"党组织讨论决定问题执行少数服从多数的原则，对于少数人的不同意见，可以不必考虑。如对重要问题发生争论，双方人数接近，要严格按照票数多少立即作出决定。","options":["正确","错误"],"answers":["错误"]},{"type":"single","question":"党员有（ ），遇到重要问题需要党组织帮助解决的，有权按照规定程序逐级向本人所在党组织、上级党组织直至中央提出请求，并要求有关党组织给予负责的答复。","options":["党内请求权","党内申诉权","党内控告权","党内申辩权"],"answers":["党内请求权"]},{"type":"single","question":"共产党员有权对党的工作提出（ ） 。","options":["批评和指正","批评和建议","建议和倡议","指正和建议"],"answers":["建议和倡议"]},{"type":"single","question":"党员必须坚持党和人民的利益高于一切，个人利益服从（ ）利益，吃苦在前，享受在后，克己奉公，多做贡献。","options":["国家","党和人民的","集体","人民的"],"answers":["党和人民的"]},{"type":"single","question":"党员有（ ），有权按照规定在党组织讨论决定问题时参加表决，在表决前了解情况，在讨论中充分发表意见。表决时可以表示赞成、不赞成或者弃权。","options":["党内表决权","党内选举权","党内控告权","党内请求权"],"answers":["党内表决权"]},{"type":"single","question":"在党支部讨论决定对违反党纪的小李作出党纪处分时，下列说法中正确的是（ ）。","options":["小李无权参加和进行申辩","其他党员不可以为他作证和辩护","小李有权参加和进行申辩，其他党员可以为他作证和辩护","小李有权参加，但不可以进行申辩"],"answers":["小李有权参加和进行申辩，其他党员可以为他作证和辩护"]},{"type":"single","question":"党员有党内请求权，遇到重要问题需要党组织帮助解决的，有权按照规定程序（ ）向本人所在党组织、上级党组织直至中央提出请求，并要求有关党组织给予负责的答复。","options":["越级","逐级","多级","同级"],"answers":["逐级"]},{"type":"single","question":"党员义务包括切实开展批评和自我批评，勇于揭露和纠正（ ）和工作中的缺点、错误，坚决同消极腐败现象作斗争。","options":["违反党的原则的言行","违反八项规定精神的言行","“四风”问题的言行","侵犯党的利益的言行"],"answers":["违反党的原则的言行"]},{"type":"single","question":"党员的义务之一是党员要模范遵守国家的法律法规，严格保守党和国家的秘密，执行党的决定，服从（ ），积极完成党的任务。","options":["大局需要","组织分配","集体利益","上级领导"],"answers":["组织分配"]},{"type":"single","question":"党组织应当健全党代表大会代表联系党员制度，支持和保障党代表大会代表加强与（ ）的联系，了解和反映党员意见和建议，听取党员对其履职的意见。","options":["领导干部","基层党员","各级党员","党代表大会"],"answers":["基层党员"]},{"type":"single","question":"党章规定，党的各级领导干部必须正确行使（ ）赋予的权力，坚持原则，依法办事，清正廉洁，勤政为民，以身作则，艰苦朴素，密切联系群众。","options":["领导","人民","国家","社会"],"answers":["人民"]},{"type":"multiple","question":"共产党员要带头参加（ ），带动群众为经济发展和社会进步艰苦奋斗。","options":["中华民族伟大复兴","改革开放","社会主义现代化建设","中国特色社会主义事业"],"answers":["改革开放","社会主义现代化建设"]},{"type":"multiple","question":"党组织作出重要决议决定前，应当通过（ ）等方式，充分征求党员意见，在党内凝聚共识、汇集智慧。","options":["调研","论证","咨询","暗访"],"answers":["调研","论证","咨询"]},{"type":"multiple","question":"党员有党内选举权，有权参加党内选举，（ ）。","options":["了解候选人情况","要求改变候选人","不选任何一个候选人","另选他人"],"answers":["了解候选人情况","要求改变候选人","不选任何一个候选人","另选他人"]},{"type":"multiple","question":"维护党的团结和统一的必须做到（ ）。","options":["坚决反对一切派别组织和小集团活动","反对阳奉阴违的两面派行为和一切阴谋诡计","对党忠诚老实，言行一致","始终把人民放在心中最高的位置"],"answers":["坚决反对一切派别组织和小集团活动","反对阳奉阴违的两面派行为和一切阴谋诡计","对党忠诚老实，言行一致"]},{"type":"multiple","question":"对党员来说，向组织反映问题，不能（ ），要有事实依据和可靠线索。","options":["捕风捉影","添油加醋","妄加揣测","以讹传讹"],"answers":["捕风捉影","添油加醋","妄加揣测","以讹传讹"]},{"type":"boolean","question":"党的任何一级组织直至中央都无权剥夺党章规定党员的权利。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党员的党内控告权没有规定必须逐级进行。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"2020年新修订的《中国共产党党员权利保障条例》第二章由原来的“党员权利”改成了“党员权利的行使”。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党组织在巡视巡察和检查督查中，可以通过个别谈话、召开座谈会、调查研究、受理来信来访等方式，广泛收集和听取党员意见建议。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党组织应当紧扣新时代党建工作特点和党员权利保障要求，创新保障党员权利的方法手段，为党员行使权利提供便捷渠道。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"申请入党的积极分子接受党组织考验时间的长短以（ ）为准。","options":["考察时间长短","申请入党的早晚","是否具备了入党条件","工作表现"],"answers":["是否具备了入党条件"]},{"type":"single","question":"预备党员转为正式党员，或延长预备期，或取消预备党员资格，都应当经（ ）讨论通过和上级党组织批准。","options":["支部大会","支部委员会","党小组","支委会全体干部"],"answers":["支部大会"]},{"type":"single","question":"预备党员转为正式党员、延长预备期或者取消预备党员资格，应当经（ ）。","options":["党支部党员大会讨论通过和上级党组织批准","有关党组织批准","支部大会讨论通过","上级党组织批准"],"answers":["党支部党员大会讨论通过和上级党组织批准"]},{"type":"single","question":"党的支部委员会对申请入党的人，要注意征求（ ）的意见。","options":["党内有关同志","党内外有关群众","所在单位","党内领导意见"],"answers":["党内外有关群众"]},{"type":"single","question":"新修订的《中国共产党发展党员工作细则》发布时间是（ ）。","options":["2014 年 5 月 28 日","2026 年 4 月 2 日","2026 年 5 月 11 日","2026 年 5 月 18 日"],"answers":["2026 年 5 月 11 日"]},{"type":"single","question":"对要求入党的积极分子进行教育和培养，要重视在生产工作第一线和（ ）中发展党员","options":["工人","农民阶级","青年","知识分子"],"answers":["青年"]},{"type":"single","question":"《中国共产党发展党员工作细则》第二十三条规定，（ ）审批前，应当指派党委委员或者组织员同发展对象谈话，作进一步的了解，并帮助发展对象提高对党的认识。","options":["党委","党组织","基层党组织","党支部"],"answers":["党委"]},{"type":"single","question":"预备党员预备期满，但在预备期内不履行党员义务，不具备党员条件的，应当（ ）。","options":["留党察看","延长预备期","取消预备党员资格","开除党籍"],"answers":["取消预备党员资格"]},{"type":"single","question":"发展党员工作应坚持党章规定的党员标准，始终把（ ）放在首位。","options":["道德标准","政治标准","纪律标准","经济标准"],"answers":["政治标准"]},{"type":"single","question":"预备党员的预备期，从（ ）算起。","options":["递交入党申请书满一年之日","支部投票通过其资格之日","支部大会通过他为预备党员之日","确定为发展对象之日"],"answers":["支部大会通过他为预备党员之日"]},{"type":"multiple","question":"在发展党员工作中，如何做到充分发挥先锋模范作用？（ ）。","options":["加大优秀共产党员宣传表彰力度，发挥先进典型的示范带动作用","构建党员联系和服务群众工作体系","以服务群众、做群众工作为主要任务，加强基层服务型党组织建设","完善党员干部直接联系群众制度"],"answers":["加大优秀共产党员宣传表彰力度，发挥先进典型的示范带动作用","构建党员联系和服务群众工作体系","以服务群众、做群众工作为主要任务，加强基层服务型党组织建设","完善党员干部直接联系群众制度"]},{"type":"multiple","question":"以下哪些人员必须参加入党宣誓仪式？（ ）","options":["需要进行入党宣誓的预备党员","组织入党宣誓仪式的党组织领导成员","预备党员所在党支部或党小组负责人","入党积极分子"],"answers":["需要进行入党宣誓的预备党员","组织入党宣誓仪式的党组织领导成员","预备党员所在党支部或党小组负责人"]},{"type":"multiple","question":"对于（ ） 的应取消预备党员资格。","options":["在预备期内不能履行党员义务","确定不具备党员条件","犯有严重错误","延长预备期后经过教育考察已不具备党员条件"],"answers":["在预备期内不能履行党员义务","确定不具备党员条件","犯有严重错误","延长预备期后经过教育考察已不具备党员条件"]},{"type":"multiple","question":"党组织应当通过党的组织生活、听取本人汇报、( )等方式，对预备党员进行教育和考察，引导其不断提高政治觉悟，自觉用党员标准严格要求自己，在生产、工作、学习和社会生活中起先锋模范作用。","options":["个别谈心","集中培训","实践锻炼","志愿服务"],"answers":["个别谈心","集中培训","实践锻炼","志愿服务"]},{"type":"multiple","question":"从申请入党到成为一名共产党员必须经过的程序是（ ）。","options":["被确定为入党积极分子","被确定为发展对象","进行政治审查","预备党员的转正"],"answers":["被确定为入党积极分子","被确定为发展对象","进行政治审查","预备党员的转正"]},{"type":"boolean","question":"党员有退党的自由。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"预备党员不履行党员义务，不具备党员条件的，应当继续延长预备期直至合格。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"入党动机正确与否，与党的纯洁性和组织战斗力没有关系。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"优秀的未成年人也可以申请入党。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"歌手江涛的《入党申请书》中提及父亲对他的教诲，主要是为了让其端正入党动机早日成为合格的共产党员。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"把入党看做是谋取私利的一种手段或途径，是（ ）。","options":["正确的入党动机","不正确的入党动机","可以理解的一种入党动机","应有的入党动机"],"answers":["不正确的入党动机"]},{"type":"single","question":"党的先进性是：（ ）。","options":["具体的历史的","一成不变的","抽象的","随着时间的推移变化的"],"answers":["具体的历史的"]},{"type":"single","question":"《论共产党员的修养》曾列为中国共产党（ ）事件的学习文件？","options":["1935年遵义会议","1942年整风运动","1935年瓦窑堡会议","1949年七届二中全会"],"answers":["1942年整风运动"]},{"type":"single","question":"《论共产党员的修养》作者是（ ）？","options":["毛泽东","朱德","刘少奇","周恩来"],"answers":["刘少奇"]},{"type":"single","question":"习近平总书记强调：“增强（），坚持说实话、谋实事、出实招、求实效，把雷厉风行和久久为功有机结合起来，勇于攻坚克难，以钉钉子精神做实做细做好各项工作。”","options":["学习本领","政治领导本领","改革创新本领","狠抓落实本领"],"answers":["狠抓落实本领"]},{"type":"single","question":"“徒有虚名的党员，就是白给，我们也不要。”这句话是（ ）说的？","options":["毛泽东","习近平","列宁","周恩来"],"answers":["列宁"]},{"type":"single","question":"中国特色社会主义进入新时代，坚持（）是全面建成小康社会、实现中华民族伟大复兴的根本保证。","options":["党对一切工作的领导","人民当家作主","依法治国","从严治党"],"answers":["党对一切工作的领导"]},{"type":"single","question":"毛泽东在《〈共产党人〉发刊词》中提出，（）是掌握统一战线和武装斗争这两个武器以实行对敌冲锋陷阵的英勇战士。","options":["领导干部","人民群众","党的组织","党支部"],"answers":["党的组织"]},{"type":"single","question":"根据中共十六大和十六届四中全会精神，中共中央从2005年1月起，在全党开展了以实践”三个代表”重要思想为主要内容的（ ）。","options":["“三讲”活动","保持共产党员先进性教育活动","加强党的作风建设活动","深入学习实践科学发展观活动"],"answers":["保持共产党员先进性教育活动"]},{"type":"single","question":"（ ）是争取入党的首要问题。","options":["端正入党动机","良好的态度","年满十八岁","坚持为人民服务"],"answers":["端正入党动机"]},{"type":"multiple","question":"树立正确的入党动机是（ ）。","options":["产生正确入党行动的前提","能够早日加入党组织","经受各种考验的重要保证","思想上入党的强大动力"],"answers":["产生正确入党行动的前提","经受各种考验的重要保证","思想上入党的强大动力"]},{"type":"multiple","question":"端正入党动机的主要途径有（ ）。","options":["认真学习马克思主义理论，确立正确的入党动机","通过实践锻炼，不断端正入党动机","加强主观世界改造，克服不正确的入党动机","要求入党的同志还应该懂得：端正入党动机，不只是入党前一时的问题，而是一辈子的事情"],"answers":["认真学习马克思主义理论，确立正确的入党动机","通过实践锻炼，不断端正入党动机","加强主观世界改造，克服不正确的入党动机","要求入党的同志还应该懂得：端正入党动机，不只是入党前一时的问题，而是一辈子的事情"]},{"type":"multiple","question":"申请入党的同志主动靠拢党组织，争取党组织对自己的帮助，通过（ ），发扬积极因素，克服消极因素，把不正确的动机改正过来。","options":["克服困难","接受党的教育","实践锻炼","自我改正"],"answers":["接受党的教育","实践锻炼","自我改正"]},{"type":"multiple","question":"老共产党员焦裕禄的故事体现了（ ）的党员特质？","options":["无私奉献","造福人民","权为民所用、利为民所谋、情为民所系","伟大人格及高尚个人情操"],"answers":["无私奉献","造福人民","权为民所用、利为民所谋、情为民所系","伟大人格及高尚个人情操"]},{"type":"multiple","question":"党组织为了维护自身纯洁性，必须严格考察入党同志的入党动机，这种考察具有（ ）。","options":["政治性","多样性","长期性","原则性"],"answers":["多样性","长期性"]},{"type":"boolean","question":"《论共产党员的修养》中指出，每一个党员都应该愉快而严肃地下定自己的决心，来担负实现共产主义这种人类历史上空前伟大而艰难的任务。我们清楚地看到共产主义事业实现过程中的困难，同时，我们又清楚地了解这种困难是一定能够在千百万群众的革命发动中完全克服的，绝不为困难所吓倒。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"财产的有无和多少作为判断先进与落后党员的标准。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"《论共产党员的修养》中指出，为了坚持这种马克思列宁主义的修养方法，我们必须坚决反对和彻底肃清旧社会在教育和学习中遗留给我们的最大祸害之一——理论和实际的脱离。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"共产党员是工人阶级的有共产主义觉悟的先锋战士，是无神论者，不得信仰宗教，不得参加宗教活动。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"《论共产党员的修养》中指出，无产阶级的最后解放，必然是全人类的最后解放。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"关于二大党章，下列说法中正确的是（ ）。","options":["规定了全国代表大会为本党最高机关","规定了党的经费收入来源有党费和党内派捐两种","规定了党章的解释权属于党的全国代表大会","规定了新党员的候补期"],"answers":["规定了全国代表大会为本党最高机关"]},{"type":"single","question":"中共一大纲领不是完全意义上的党章，原因是（ ）。","options":["没有全员通过","没有贯彻执行","内容有局限性","理论准备不足"],"answers":["内容有局限性"]},{"type":"single","question":"五大会议期间没有通过新党章原因是（ ）。","options":["革命形势危急","五大党章不合理","党内反对修改党章","左倾错误的干扰"],"answers":["革命形势危急"]},{"type":"single","question":"中共中央政治局于1927年6月1日通过了（ ）。","options":["三大党章","四大党章","中国共产党第三次修正章程决议案","中国共产党第四次修正章程决议案"],"answers":["中国共产党第三次修正章程决议案"]},{"type":"single","question":"1927年6月，中共中央政治局会议通过的（ ）是党的历史上唯一不是由党的代表大会制定和修改的党章。","options":["《中国共产党第一次修正章程决案》","《中国共产党第二次修正章程决案》","《中国共产党第三次修正章程决案》","四大党章"],"answers":["《中国共产党第三次修正章程决案》"]},{"type":"single","question":"中共第三次修正章程中（ ）。","options":["规定党部的指导原则为民主集中制","实行党的总书记制度","强调了对党员日常监督管理工作","将接受新党员的审批权做了调整"],"answers":["规定党部的指导原则为民主集中制"]},{"type":"single","question":"中共三大党章通过的地点是（ ）。","options":["上海","广州","武汉","汉口"],"answers":["广州"]},{"type":"single","question":"中共二大党章最突出的特征是（ ）。","options":["比较完整的党章系统","明确规定为党章","由全国代表大会通过","对党影响巨大"],"answers":["比较完整的党章系统"]},{"type":"single","question":"讨论并通过党的第一部正式党章的会议是（ ）。","options":["中共一大","中共二大","南湖会议","中共三大"],"answers":["中共二大"]},{"type":"single","question":"第一次增写了“党徽党旗”一章的党章（ ）。","options":["十五大党章","十六大党章","十七大党章","十八大党章"],"answers":["十六大党章"]},{"type":"multiple","question":"二十大党章规定，习近平新时代中国特色社会主义思想是对马克思列宁主义、毛泽东思想、邓小平理论、“三个代表”重要思想、科学发展观的继承和发展，是（ ），是中国特色社会主义理论体系的重要组成部分，是全党全国人民为实现中华民族伟大复兴而奋斗的行动指南，必须长期坚持并不断发展。","options":["当代中国马克思主义","二十一世纪马克思主义","是中华文化和中国精神的时代精华","是党和人民实践经验和集体智慧的结晶"],"answers":["当代中国马克思主义","二十一世纪马克思主义","是中华文化和中国精神的时代精华","是党和人民实践经验和集体智慧的结晶"]},{"type":"multiple","question":"七大党章关于党的组织原则组织制度党的纪律党员的权利与义务及党的作风等有关方面的规定标志着（ ）。","options":["思想建设","组织建设","纪律建设","作风建设"],"answers":["组织建设","纪律建设","作风建设"]},{"type":"multiple","question":"下列关于八大党章的说法中，正确的有（ ）。","options":["于1956年9月26日通过","党执政后第一部党章","提出了全面建设社会主义的任务","首次把“各尽所能，按劳取酬”的分配原则写进党章"],"answers":["于1956年9月26日通过","党执政后第一部党章","提出了全面建设社会主义的任务","首次把“各尽所能，按劳取酬”的分配原则写进党章"]},{"type":"multiple","question":"党章规定，发展党员，必须把政治标准放在首位，必须经过（ ），坚持（ ）的原则。","options":["党的支部","党员代表大会","个别吸收","全面考察"],"answers":["党的支部","个别吸收"]},{"type":"multiple","question":"七大党章的突出特点有（ ）。","options":["增写了总纲部分","确立了毛泽东思想是党的指导思想","党第一部完全独立自主制定的党章","第一次规定了党员的权利和义务"],"answers":["增写了总纲部分","确立了毛泽东思想是党的指导思想","党第一部完全独立自主制定的党章","第一次规定了党员的权利和义务"]},{"type":"boolean","question":"四大党章首次规定“凡有党员三人以上均得成立一支部”。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"七大通过的党章是党在民主革命时期最好的一部党章，是党成熟的重要标志。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"十五大党章明确规定，把邓小平理论确立为党的指导思想。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"十二大通过的新党章是我党自执政以来最好的一部党章。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"三大党章关于党员入党手续方面，第一次规定了新党员候补期，即劳动者六个月，非劳动者九个月。","options":["正确","错误"],"answers":["错误"]},{"type":"single","question":"中国共产党为什么能，中国特色社会主义为什么好，归根到底是马克思主义行，是（ ）的马克思主义行。","options":["制度化标准化","中国化时代化","现代化","中国式现代化"],"answers":["中国化时代化"]},{"type":"single","question":"《中共中央关于进一步全面深化改革 推进中国式现代化的决定》指出，完善劳动者工资决定、合理增长、支付保障机制，健全（ ）政策制度。","options":["初次分配","再分配","第三次分配","按要素分配"],"answers":["按要素分配"]},{"type":"single","question":"全党必须牢记，全面从严治党永远在路上，（ ）永远在路上。","options":["作风建设","反腐倡廉","依法治国","党的自我革命"],"answers":["党的自我革命"]},{"type":"single","question":"党的二十届三中全会指出，健全提升产业链供应链（）和安全水平制度。","options":["弹性","刚性","抗压性","韧性"],"answers":["韧性"]},{"type":"single","question":"（）是实现中华民族伟大复兴的必由之路。","options":["全面从严治党","贯彻新发展理念","中国特色社会主义","坚持党的全面领导"],"answers":["中国特色社会主义"]},{"type":"single","question":"《中共中央关于进一步全面深化改革 推进中国式现代化的决定》指出，坚持（），处理好经济和社会、政府和市场、效率和公平、活力和秩序、发展和安全等重大关系，增强改革系统性、整体性、协同性。","options":["自信自立","守正创新","问题导向","系统观念"],"answers":["系统观念"]},{"type":"single","question":"党的二十大报告指出，必须（ ）贯彻新发展理念，坚持社会主义市场经济改革方向，坚持高水平对外开放，加快构建以国内大循环为主体、国内国际双循环相互促进的新发展格局。","options":["客观、公平、公正","完整、准确、全面","全面、客观、深入","坚定不移、不折不扣"],"answers":["完整、准确、全面"]},{"type":"single","question":"关于文化体制改革，全会提出要优化什么机制？","options":["文化产品进口机制","文化服务和文化产品供给机制","文化企业管理机制","文化市场监管机制"],"answers":["文化服务和文化产品供给机制"]},{"type":"single","question":"党的二十届三中全会指出，（）是中国式现代化的本质要求。","options":["发展全过程人民民主","法治建设","高质量发展","对外开放"],"answers":["发展全过程人民民主"]},{"type":"single","question":"《中共中央关于进一步全面深化改革 推进中国式现代化的决定》中指出，优化事业单位结构布局，强化（ ）。","options":["服务性","公益性","实体性","文化性"],"answers":["公益性"]},{"type":"multiple","question":"全会提出要深化生态文明体制改革，包括哪些方面？","options":["完善生态文明基础体制","健全生态环境治理体系","健全绿色低碳发展机制","实施分区域、差异化、精准管控的生态环境管理制度"],"answers":["完善生态文明基础体制","健全生态环境治理体系","健全绿色低碳发展机制","实施分区域、差异化、精准管控的生态环境管理制度"]},{"type":"multiple","question":"《中共中央关于进一步全面深化改革 推进中国式现代化的决定》中指出，完善（ ）的立法工作格局。","options":["党委领导","人大主导","政府依托","各方参与"],"answers":["党委领导","人大主导","政府依托","各方参与"]},{"type":"multiple","question":"党的二十大报告指出，要坚持（ ）一体推进，同时发力、同向发力、综合发力。以零容忍态度反腐惩恶，更加有力遏制增量，更加有效清除存量。","options":["不敢腐","不能腐","不想腐","不用腐"],"answers":["不敢腐","不能腐","不想腐"]},{"type":"multiple","question":"《中共中央关于进一步全面深化改革 推进中国式现代化的决定》提出，推动科技创新力量、要素配置、人才队伍（ ）。","options":["高效化","体系化","建制化","协同化"],"answers":["体系化","建制化","协同化"]},{"type":"multiple","question":"《中共中央关于进一步全面深化改革 推进中国式现代化的决定》指出，按照（）原则，稳妥有序推进渐进式延迟法定退休年龄改革。","options":["自愿","统一","法定","弹性"],"answers":["自愿","弹性"]},{"type":"boolean","question":"《中共中央关于进一步全面深化改革、推进中国式现代化的决定》指出：深化国资国企改革，完善管理监督体制机制，增强各有关管理部门战略协同，推进国有经济布局优化和结构调整，推动国有资本和国有企业做强做优做大，增强核心功能，提升核心竞争力。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"中国特色社会主义是党和人民历经千辛万苦、付出巨大代价取得的根本成就，是实现中华民族伟大复兴的正确道路。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"《中共中央关于进一步全面深化改革、推进中国式现代化的决定》指出：加快新一代信息技术全方位全链条普及应用，发展工业互联网，打造具有国际竞争力的数字产业集群。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的二十大报告指出，十年来，我们确立党在新时代的强军目标，贯彻新时代党的强军思想，贯彻新时代军事战略方针，坚持党对人民军队的绝对领导。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的二十大报告指出，推进马克思主义中国化时代化是一个追求真理、揭示真理、笃行真理的过程。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"二十届四中全会强调，要深入推进以（）为核心的新型城镇化。","options":["产业发展","经济增长","人为本","城市建设"],"answers":["人为本"]},{"type":"single","question":"党的二十届四中全会提出，要稳步扩大（），这是新时代对外开放的鲜明特征。","options":["出口规模","制度型开放","招商引资范围","开发区数量"],"answers":["制度型开放"]},{"type":"single","question":"党的二十届四中全会指出，（ ）是中国式现代化的重要标志。坚持马克思主义在意识形态领域的指导地位，植根博大精深的中华文明，顺应信息技术发展潮流，发展具有强大思想引领力、精神凝聚力、价值感召力、国际影响力的新时代中国特色社会主义文化，扎实推进文化强国建设。","options":["文化繁荣兴盛","发展新型文化业态","高质量发展","高科技创新"],"answers":["文化繁荣兴盛"]},{"type":"single","question":"党的二十届四中全会指出，“十五五”时期经济社会发展必须遵循以下原则，坚持党的全面领导，坚持人民至上，坚持高质量发展，坚持全面深化改革，坚持（ ），坚持统筹发展和安全。","options":["发展新质生产力","有效市场和有为政府相结合","国内国际双循环","国内大循环"],"answers":["有效市场和有为政府相结合"]},{"type":"single","question":"党的二十届四中全会指出，（ ）是中国式现代化的战略依托。","options":["强大国内市场","坚持扩大内需","坚持双循环","强大国外市场"],"answers":["强大国内市场"]},{"type":"single","question":"发展新时代中国特色社会主义文化，必须植根于（）。","options":["世界各国的先进文化","博大精深的中华文明","网络信息文化","现代流行文化"],"answers":["博大精深的中华文明"]},{"type":"single","question":"党的二十届四中全会指出，（ ）是中国式现代化的物质技术基础。","options":["先进制造业","现代化产业体系","先进服务业","先进科技产业"],"answers":["现代化产业体系"]},{"type":"single","question":"“十四五”时期，我们经受住了（）的严重冲击。","options":["全球经济危机","世纪疫情","重大自然灾害","国际地缘冲突"],"answers":["世纪疫情"]},{"type":"single","question":"下列哪项是筑牢生态安全屏障、增强绿色发展动能的直接举措？（）","options":["持续深入推进污染防治攻坚和生态系统优化","加快传统能源开采力度","先污染后治理","降低生态环境保护标准"],"answers":["持续深入推进污染防治攻坚和生态系统优化"]},{"type":"single","question":"二十届四中全会提出的农业农村工作的战略目标是（）。","options":["实现城乡无差别化","加快建设农业强国","完全依靠国际市场保障粮食安全","减少农村人口数量"],"answers":["加快建设农业强国"]},{"type":"multiple","question":"党的二十届四中全会指出，要促进香港、澳门长期繁荣稳定。必须坚定不移贯彻（ ），落实“爱国者治港”、“爱国者治澳”原则，提升港澳依法治理效能，促进港澳经济社会发展。","options":["“一国两制”","“港人治港”","“澳人治澳”","高度自治方针"],"answers":["“一国两制”","“港人治港”","“澳人治澳”","高度自治方针"]},{"type":"multiple","question":"下列哪些属于全会提出的保障和改善民生的具体任务？（）","options":["促进高质量充分就业","完善收入分配制度","办好人民满意的教育","健全社会保障体系","推动房地产高质量发展","加快建设健康中国"],"answers":["促进高质量充分就业","完善收入分配制度","办好人民满意的教育","健全社会保障体系","推动房地产高质量发展","加快建设健康中国"]},{"type":"multiple","question":"党的二十届四中全会指出，（ ）是中国式现代化的战略支撑。","options":["巩固国防","网络安全","强大军队","科技发展"],"answers":["巩固国防","强大军队"]},{"type":"multiple","question":"党的二十届四中全会为加快农业农村现代化提出的具体举措包括（）。","options":["提升农业综合生产能力和质量效益","推进宜居宜业和美乡村建设","提高强农惠农富农政策效能","促进城乡融合发展"],"answers":["提升农业综合生产能力和质量效益","推进宜居宜业和美乡村建设","提高强农惠农富农政策效能","促进城乡融合发展"]},{"type":"boolean","question":"党的市（地、州、盟）和县（市、区、旗）委员会建立巡察制度，设立巡察机构，在一届任期内，对所管理的党组织实现巡察全覆盖。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"我们要正确看待当前反腐败斗争形势。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的二十届四中全会指出，促进各类要素资源高效配置，建立健全城乡统一的建设用地市场、功能完善的资本市场、流动顺畅的劳动力市场、转化高效的技术市场。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的二十届四中全会指出，要赋予省级政府统筹建设用地更大自主权，探索实施建设用地总量按规划期管控模式，实行统筹存量和增量综合供地。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"各级党委特别是市县党委要把整治群众身边不正之风和腐败问题作为重要任务常态化地抓，让老百姓可感可及。","options":["正确","错误"],"answers":["正确"]},{"type":"single","question":"中国共产党党员是中国（ ）的有共产主义觉悟的先锋战士。","options":["农民阶级","知识分子","工农联盟","工人阶级"],"answers":["工人阶级"]},{"type":"single","question":"下列不属于批评和自我批评作风的是（ ）。","options":["坚持原则，以理服人","注意调查研究","鼓励人民群众对党的批评","经常开展自我批评"],"answers":["注意调查研究"]},{"type":"single","question":"对于严重触犯党的纪律和国家法律的党员，党的纪律检查委员会可以（ ）。","options":["开除党籍","量罪判刑","拘役罚款","剥夺政治权利终身"],"answers":["开除党籍"]},{"type":"single","question":"党的十八届六中全会提出，建设廉洁政治，坚决反对腐败，是加强和规范党内政治生活的（）任务。","options":["艰巨","唯一","重要","主要"],"answers":["重要"]},{"type":"single","question":"作风问题核心是（）。","options":["政风问题","党性问题","党风问题","党同人民群众的关系问题"],"answers":["党同人民群众的关系问题"]},{"type":"single","question":"党的县（旗）、自治县、不设区的市和市辖区的委员会。这些委员会的委员和候补委员必须有（ ）年以上的党龄。","options":["三","四","五","二"],"answers":["三"]},{"type":"single","question":"党的基层组织有（ ）基本任务。","options":["4项","6项","8项","10项"],"answers":["8项"]},{"type":"single","question":"（ ）是中央政治局和它的常务委员会的办事机构。","options":["中央书记处","国务院","全国人民代表大会","党的代表大会"],"answers":["中央书记处"]},{"type":"single","question":"不断提升党组织的群众组织力要坚持理论武装，提升群众（）。","options":["凝聚力","向心力","说服力","影响力"],"answers":["说服力"]},{"type":"single","question":"（ ）应当担负起第一责任人的职责，加强对党员权利保障工作的调查研究和相关机制建设，推动解决突出问题，抓好本地区本部门本单位党员权利保障工作的落实。","options":["领导干部特别是高级干部","各级党组织主要负责同志","党支部书记","党组领导"],"answers":["各级党组织主要负责同志"]},{"type":"single","question":"党员有（ ），对于党组织给予本人的处理、处分或者作出的鉴定、审查结论不服的，有权按照规定程序逐级向本人所在党组织、上级党组织直至中央提出申诉。","options":["党内申诉权","党内申辩权","党内控告权","党内请求权"],"answers":["党内申诉权"]},{"type":"single","question":"解放战争初期，面对国民党军队气势汹汹的全面进攻，毛泽东提出了“一切反动派都是纸老虎”的著名论断。这一论断的主要依据是（ ）。","options":["人民解放军具有坚强的战斗力","国统区人民民主运动开始高涨","人民解放军有巩固的战略后方","国民政府统治腐败不得人心"],"answers":["国民政府统治腐败不得人心"]},{"type":"single","question":"关于中共七大的说法不正确的是（ ）。","options":["1945年4月在延安举行","制定了党的政治路线","毛泽东作了《关于修改党的章程的报告》","为争取抗战胜利准备了条件"],"answers":["毛泽东作了《关于修改党的章程的报告》"]},{"type":"single","question":"中国共产党领导人民打江山、守江山，守的是（ ）。","options":["人民的心","人民满意","人民的拥护","人民的支持"],"answers":["人民的心"]},{"type":"single","question":"党的二十大报告指出，要建设覆盖（ ）的现代公共法律服务体系，深入开展法治宣传教育，增强全民法治观念。","options":["城乡","城市","农村","城镇"],"answers":["城乡"]},{"type":"single","question":"全会提出要优化哪些地区的开放布局？","options":["仅东部沿海地区","仅中西部地区","仅东北地区","东部沿海地区、中西部和东北地区"],"answers":["东部沿海地区、中西部和东北地区"]},{"type":"single","question":"全会强调要健全什么体系，加强普惠性、基础性、兜底性民生建设？","options":["基本公共服务制度体系","社会保障制度体系","医疗卫生制度体系","教育制度体系"],"answers":["基本公共服务制度体系"]},{"type":"single","question":"全会提出要完善促进什么协同发展和治理？","options":["医疗、医保、医药","教育、就业、社保","住房、交通、环境","文化、旅游、体育"],"answers":["医疗、医保、医药"]},{"type":"single","question":"关于人才发展，全会强调要加快建设什么？","options":["国家重点人才基地","国家高水平人才高地","国家创新人才中心","国家技能人才库"],"answers":["国家高水平人才高地"]},{"type":"single","question":"关于对外开放，全会强调要依托我国什么优势，在扩大国际合作中提升开放能力？","options":["人口优势","地理优势","超大规模市场优势","资源优势"],"answers":["超大规模市场优势"]},{"type":"single","question":"党的二十届四中全会公报中，下列哪一项不属于“四个全面”战略布局的内容？（）","options":["全面深化改革","全面依法治国","全面从严治党","全面建设小康社会","全面建设社会主义现代化国家"],"answers":["全面建设小康社会"]},{"type":"single","question":"党的二十届四中全会提出，促进服务业优质高效发展。提高现代服务业与先进制造业、现代农业融合发展水平，推进服务业（ ）。","options":["数智化","专业化","数治化","高质量发展"],"answers":["数智化"]},{"type":"single","question":"党的二十大报告指出，高质量发展是全面建设社会主义现代化国家的（ ）任务。","options":["重要","根本","首要","唯一"],"answers":["首要"]},{"type":"single","question":"1987年10月25日，中国共产党第（ ）次全国代表大会在北京召开。","options":["十二","十三","十四","十五"],"answers":["十三"]},{"type":"single","question":"五四运动被作为新民主主义革命的开端是因为（ ）。①中国革命性质和社会性质发生了变化②革命的领导阶级和指导思想发生了变化③具有以往历次革命运动所没有的广泛性④开始了马克思主义与中国工人运动相结合的过程","options":["①③④","①④","②③","②③④"],"answers":["②③④"]},{"type":"single","question":"鼓励一部分地区和一部分人先富起来，（ ），在生产发展和社会财富增长的基础上不断满足人民日益增长的美好生活需要。","options":["逐步消灭剥削，达到共同富裕","逐步消灭贫穷，达到共同富裕","逐步消除两极分化，达到共同富裕","逐步消除贫富观念，达到共同富裕"],"answers":["逐步消灭贫穷，达到共同富裕"]},{"type":"single","question":"党在社会主义初级阶段的基本纲领最早是什么时候提出的？（ ）","options":["十一届三中全会","中共十三大","中共十四大","中共十五大"],"answers":["中共十五大"]},{"type":"multiple","question":"党的“三个代表”之间的关系是（ ）。","options":["发展先进生产力和先进文化是实现最广大人民根本利益的基础和前提","只有不断发展和繁荣社会主义文化，才能为发展生产力提供强大的精神动力和智力支持","实现最广大人民根本利益是发展先进生产力和先进文化的目的和归宿","人民群众既是先进生产力和先进文化的创造者，又是其成果的享有者"],"answers":["发展先进生产力和先进文化是实现最广大人民根本利益的基础和前提","只有不断发展和繁荣社会主义文化，才能为发展生产力提供强大的精神动力和智力支持","实现最广大人民根本利益是发展先进生产力和先进文化的目的和归宿","人民群众既是先进生产力和先进文化的创造者，又是其成果的享有者"]},{"type":"multiple","question":"全面建设社会主义现代化国家,是一项伟大而艰巨的事业。前途光明,任重道远，前进道路上,必须牢牢把握的重大原则是:坚持和加强党的全面领导,（ ）。","options":["坚持中国特色社会主义道路","坚持以人民为中心的发展思想","坚持深化改革开放","坚持发扬斗争精神"],"answers":["坚持中国特色社会主义道路","坚持以人民为中心的发展思想","坚持深化改革开放","坚持发扬斗争精神"]},{"type":"multiple","question":"党组织应当通过党的组织生活、（ ）等方式，对预备党员进行教育和考察。","options":["听取本人汇报","个别谈心","集中培训","实践锻炼"],"answers":["听取本人汇报","个别谈心","集中培训","实践锻炼"]},{"type":"multiple","question":"发展党员工作必须坚持的原则有（ ）。","options":["入党自愿原则","个别吸收原则","突击发展原则","关门主义原则"],"answers":["入党自愿原则","个别吸收原则"]},{"type":"multiple","question":"中国共产党是（ ）的先锋队。","options":["中国工人阶级","中国无产阶级","中国人民和中华民族","中国农民阶级"],"answers":["中国工人阶级","中国人民和中华民族"]},{"type":"multiple","question":"《党章》党员中第二条要求，中国共产党党员（ ）。","options":["是中国工人阶级的有共产主义觉悟的先锋战士","必须全心全意为人民服务，不惜牺牲个人的一切，为实现共产主义奋斗终身","必须经过党的支部大会讨论通过","永远是劳动人民的普通一员"],"answers":["是中国工人阶级的有共产主义觉悟的先锋战士","必须全心全意为人民服务，不惜牺牲个人的一切，为实现共产主义奋斗终身","永远是劳动人民的普通一员"]},{"type":"multiple","question":"十二大党章强调各级组织必须遵守（ ）的原则。","options":["集体领导","个人决定","民主集中制","领导决定"],"answers":["集体领导","民主集中制"]},{"type":"multiple","question":"党和群众的关系是（ ）。","options":["人民离不开党","人民领导党","党依靠人民","党为人民服务"],"answers":["人民离不开党","党依靠人民","党为人民服务"]},{"type":"multiple","question":"党的二十大报告指出：我们要坚持马克思主义在意识形态领域指导地位的根本制度（ ），以社会主义核心价值观为引领，发展社会主义先进文化，弘扬革命文化，传承中华优秀传统文化，满足人民日益增长的精神文化需求，巩固全党全国各族人民团结奋斗的共同思想基础，不断提升国家文化软实力和中华文化影响力。","options":["坚持为人民服务、为社会主义服务","坚持百花齐放、百家争鸣","坚持创造性转化、创新性发展","坚持实事求是、与时俱进"],"answers":["坚持为人民服务、为社会主义服务","坚持百花齐放、百家争鸣","坚持创造性转化、创新性发展"]},{"type":"multiple","question":"关于深化财税体制改革，全会提出了哪些措施？","options":["增加地方自主财力","拓展地方税源","合理扩大地方政府专项债券支持范围","适当加强中央事权、提高中央财政支出比例"],"answers":["增加地方自主财力","拓展地方税源","合理扩大地方政府专项债券支持范围","适当加强中央事权、提高中央财政支出比例"]},{"type":"multiple","question":"《中共中央关于进一步全面深化改革、推进中国式现代化的决定》提出，统一预算分配权，提高预算管理（），完善预算公开和监督制度。","options":["统一性","规范性","有效性","可操作性"],"answers":["统一性","规范性"]},{"type":"multiple","question":"《中共中央关于进一步全面深化改革 推进中国式现代化的决定》指出，规范收入分配秩序，规范财富积累机制，多渠道增加城乡居民财产性收入，形成（ ）的制度体系。","options":["消除绝对贫困人口","有效增加低收入群体收入","稳步扩大中等收入群体规模","合理调节过高收入"],"answers":["有效增加低收入群体收入","稳步扩大中等收入群体规模","合理调节过高收入"]},{"type":"multiple","question":"文化数据资产化主要表现在文化数据（）。","options":["可溯源","可量化","可交易","可存储"],"answers":["可溯源","可量化","可交易"]},{"type":"multiple","question":"习近平总书记指出，我国是一个发展中大国，正在大力推进（ ），必须把创新驱动发展战略实施好。","options":["经济发展方式转变","经济发展方式调整","经济结构调整","经济结构转变"],"answers":["经济发展方式转变","经济结构调整"]},{"type":"multiple","question":"抗日战争时期党领导的武装力量有（ ）。","options":["八路军","新四军","山西青年抗敌决死队","东江纵队"],"answers":["八路军","新四军","山西青年抗敌决死队","东江纵队"]},{"type":"multiple","question":"习近平指出，督促党员、干部坚决反对特权思想和特权现象，树牢正确（）。","options":["群众观","权力观","政绩观","事业观"],"answers":["权力观","政绩观","事业观"]},{"type":"multiple","question":"党的二十届四中全会规定，要坚持全面依法治国，必须协同推进（ ）","options":["科学立法","严格执法","公正司法","全民守法"],"answers":["科学立法","严格执法","公正司法","全民守法"]},{"type":"multiple","question":"党的性质决定着（ ）。","options":["党的全部活动的方向和内容","党的地位和作用","党的奋斗目标和终生追求","党的命运和前途"],"answers":["党的全部活动的方向和内容","党的地位和作用"]},{"type":"multiple","question":"我们要高度重视基层党组织建设，以提升组织力为重点，突出政治功能，使（）。","options":["组织强起来","党员强起来","政策强起来","党的工作强起来"],"answers":["组织强起来","党员强起来","党的工作强起来"]},{"type":"multiple","question":"党的基层组织，根据工作需要和党员人数，经上级党组织批准，分别设立（ ）。","options":["党的基层委员会","支部委员会","党小组","总支部委员会"],"answers":["党的基层委员会","支部委员会","总支部委员会"]},{"type":"multiple","question":"《党章》指出：我国社会主义建设的根本任务，是进一步解放生产力，发展生产力，逐步实现社会主义现代化，并且为此而改革生产关系和上层建筑中不适应生产力发展的方面和环节。这段话蕴含的历史唯物主义原理有：（ ）。","options":["生产力决定生产关系，生产力是生产关系形成的前提和基础","生产关系反作用于生产力，要适应生产力的发展而调整","生产关系在一定条件下对生产力也会起到决定作用","上层建筑要适时调整以适应生产力的发展"],"answers":["生产力决定生产关系，生产力是生产关系形成的前提和基础","生产关系反作用于生产力，要适应生产力的发展而调整","上层建筑要适时调整以适应生产力的发展"]},{"type":"multiple","question":"开除党籍是党内的一种纪律处分，下列相关说法正确的有（ ）。","options":["开除党籍是党内最高处分","一旦开除党籍，不得再入党","开除党籍处分的党员，其党内职务自然终止","只有触犯刑法才会开除党籍"],"answers":["开除党籍是党内最高处分","开除党籍处分的党员，其党内职务自然终止"]},{"type":"multiple","question":"党的政治纪律是指全党在（ ）方面必须遵守的刚性约束。","options":["政治方向","政治立场","政治言论","政治行动"],"answers":["政治方向","政治立场","政治言论","政治行动"]},{"type":"multiple","question":"党在任何时候都把群众利益放在第一位，同群众同甘共苦，保持最密切的联系，坚持（ ），不允许任何党员脱离群众，凌驾于群众之上。","options":["权为民所用","情为民所系","利为民所谋","事为民所想"],"answers":["权为民所用","情为民所系","利为民所谋"]},{"type":"boolean","question":"党在社会主义初级阶段的基本纲领最初是邓小平提出的。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"党员以书面方式提出的批评意见可以不用送被批评者或者有关党组织。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"党领导人民建设社会主义生态文明，必须要坚持节约资源和保护环境的基本国策。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"第一次明确提出了反帝反封建的民主革命纲领的是中共三大。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"对党员干部不顾党和国家大局，搞部门或者地方保护主义的，按照情节轻重给予相应处分。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"对正式党员的纪律处分，也适应于预备党员。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党内通报批评就是警告处分，可以起到警示、告诫的作用。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"《中国共产党纪律处分条例》规定，一个违纪行为同时触犯本条例两个以上条款的，依照处分较重的条款定性处理。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的二十大报告指出，我们要夯实国家安全和社会稳定基层基础，完善参与全球安全治理机制，建设更高水平的平安中国，以新安全格局保障新发展格局。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"全面建设社会主义现代化国家和实现中华民族伟大复兴不是同一个目标。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"我国正处于并将长期处于社会主义初级阶段。这是在经济文化落后的中国建设社会主义现代化不可逾越的历史阶段，需要一百年的时间。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"推进政治监督常态化，行动上，要坚持把党中央各项决策部署落实情况作为政治监督重点，合力推动改革攻坚、促进高质量发展。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"党的二十届四中全会指出，要建立健全一体推进的协调机制，强化规划衔接、政策协同、资源统筹、评价联动，促进科技自主创新和人才自主培养良性互动，建设具有全球影响力的教育中心、科学中心、人才中心。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"《中国共产党党员权利保障条例》规定，在对党员进行监督执纪中应当充分保障党员权利，严格依规依纪依法开展工作，不得使用违反党章党规党纪和法律法规的手段、措施。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"七大通过的党章是中国共产党第一部完全独立自主制定的党章。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"十七大对党章的修改标志着中国共产党治国理政的新的发展。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"预备党员政治素质差，表现不好的，可以做劝其退党处理。","options":["正确","错误"],"answers":["错误"]},{"type":"boolean","question":"不论我国处于新民主主义阶段，还是处于社会主义阶段，作为工人阶级的先锋战士的共产党员，都要有共产主义觉悟，共产党员的根本标准是绝对不能降低的。","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"毛主席说：“共产党是为民族、为人民谋利益的政党，它本身决无私利可图。”","options":["正确","错误"],"answers":["正确"]},{"type":"boolean","question":"只有中国共产党才能够肩负起民族的希望，才能领导中国人民把历史推向前进。","options":["正确","错误"],"answers":["正确"]},{"type":"fill","question":"党的二十届四中全会指出，要推进（ ），营造全社会崇尚法治、恪守规则、尊重契约、维护公正的良好环境。","options":[],"answers":["法治社会建设"]},{"type":"fill","question":"根据遵义会议精神，在红军转战至川滇黔交界时，政治局常委进行分工，决定由（ ）代替博古负党中央总的责任。","options":[],"answers":["张闻天"]},{"type":"fill","question":"党员对党的政策有不同意见时，在（ ）的前提下，可以声明保留，并且可以把自己的意见向党的上级组织直至中央提出。","options":[],"answers":["坚决执行"]},{"type":"fill","question":"（ ）必须面向党旗进行入党宣誓。","options":[],"answers":["预备党员"]},{"type":"fill","question":"讨论预备党员转正的支部大会，对到会人数、赞成人数等要求与讨论（ ）的党支部党员大会相同。","options":[],"answers":["接收预备党员"]},{"type":"fill","question":"党的二十大报告指出：全面建设社会主义现代化国家，必须坚持（ ），增强文化自信，围绕举旗帜、聚民心、育新人、兴文化、展形象建设社会主义文化强国。","options":[],"answers":["中国特色社会主义文化发展道路"]},{"type":"fill","question":"在新世纪新时代，经济和社会发展的战略目标是，到建党一百年时，全面建成小康社会；到新中国成立一百年时，全面建成（ ）。","options":[],"answers":["社会主义现代化强国"]},{"type":"fill","question":"支部大会讨论接收预备党员时，与会党员对发展对象能否入党进行充分讨论，并采取（ ）投票方式进行表决。","options":[],"answers":["无记名"]},{"type":"fill","question":"全会强调，高水平社会主义市场经济体制是（ ）的重要保障。","options":[],"answers":["中国式现代化"]},{"type":"fill","question":"弘扬以伟大建党精神为源头的中国共产党人精神谱系，用好红色资源，深入开展社会主义核心价值观宣传教育，深化（ ）、集体主义、社会主义教育，着力培养担当民族复兴大任的时代新人。","options":[],"answers":["爱国主义"]},{"type":"fill","question":"我国是工人阶级领导的、以工农联盟为基础的（ ）的社会主义国家，国家的一切权力属于人民。","options":[],"answers":["人民民主专政"]},{"type":"fill","question":"中国共产党第二十次全国代表大会，是在全党全国各族人民迈上（ ）新征程、向第二个百年奋斗目标进军的关键时刻召开的一次十分重要的大会。","options":[],"answers":["全面建设社会主义现代化国家"]},{"type":"fill","question":"社会主义改造基本完成后，我国国家政治生活的主题是（ ）。","options":[],"answers":["正确处理人民内部矛盾"]},{"type":"fill","question":"中国共产党代表（ ）的发展要求，代表中国先进文化的前进方向，代表中国最广大人民的根本利益。","options":[],"answers":["中国先进生产力"]},{"type":"fill","question":"（ ）是争取入党的首要问题。","options":[],"answers":["端正入党动机"]},{"type":"fill","question":"毛泽东思想的成熟时期是在（ ）时期。","options":[],"answers":["抗日战争"]},{"type":"fill","question":"（ ）是维护党的团结统一、完成党的任务的保证。","options":[],"answers":["党的纪律"]},{"type":"fill","question":"党的七大党章最大特色就是把（ ）确立为党的指导思想。","options":[],"answers":["毛泽东思想"]},{"type":"fill","question":"中国共产党第十九次全国代表大会的主题是不忘初心，牢记使命，高举中国特色社会主义伟大旗帜，决胜全面建成小康社会，夺取新时代中国特色社会主义伟大胜利，为（ ）的中国梦不懈奋斗。","options":[],"answers":["实现中华民族伟大复兴"]},{"type":"fill","question":"毛泽东提出“枪杆子里面出政权”的著名论断是在（ ） 会议上。","options":[],"answers":["八七"]}]);
})();
