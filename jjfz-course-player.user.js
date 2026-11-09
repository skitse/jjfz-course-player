// ==UserScript==
// @name         JJFZ 培训视频续播
// @namespace    https://github.com/skitse/jjfz-course-player
// @version      0.3.3
// @description  积极分子（JJFZ）培训视频队列，支持断点续播与静音
// @match        *://*/jjfz/lesson*
// @match        *://*/jjfz/play*
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
    const value = prompt('每行填一个地址，顺序为课程中心、课件列表、视频播放页。支持本站完整网址或路径，留空恢复默认。', (configuredRoutes ?? defaultRoutes).join('\n'));
    if (value === null) return;
    const routes = value.trim() ? parseRoutes(value.trim().split(/\r?\n/)) : null;
    if (value.trim() && !routes) {
      alert('请输入三个不同的本站地址。');
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
    if (!Array.isArray(values) || values.length !== 3) return null;
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
      : `队列已结束 · ${queue.entries.length} 个视频均已收到完成回执`;
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
