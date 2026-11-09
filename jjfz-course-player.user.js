// ==UserScript==
// @name         JJFZ 培训视频续播
// @namespace    https://github.com/skitse/jjfz-course-player
// @version      0.3.0
// @description  从兼容站点的课程中心生成必修视频队列，按课程、课件和分集顺序续播
// @match        *://*/jjfz/lesson*
// @match        *://*/jjfz/play*
// @license      MIT
// @homepageURL  https://github.com/skitse/jjfz-course-player
// @supportURL   https://github.com/skitse/jjfz-course-player/issues
// @updateURL    https://github.com/skitse/jjfz-course-player/releases/latest/download/jjfz-course-player.user.js
// @downloadURL  https://github.com/skitse/jjfz-course-player/releases/latest/download/jjfz-course-player.user.js
// @run-at       document-idle
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  const page = new URL(location.href);
  const centerPath = '/jjfz/lesson';
  const catalogPath = '/jjfz/lesson/video';
  const playerPath = '/jjfz/play';
  const path = page.pathname.replace(/\/$/, '');
  const stage = page.searchParams.get('stg');
  if (![centerPath, playerPath].includes(path) || !stage) return;

  const centerUrl = new URL(centerPath, page);
  centerUrl.searchParams.set('stg', stage);
  const centerHasCourses = path === centerPath && listCourses(document, page).length > 0;
  const isPlayer = path === playerPath && playbackUrl(page.href) && document.querySelector('.vlist .vitem.active');
  if (!centerHasCourses && !isPlayer) return;

  const enabledKey = 'jjfz-course-player:enabled:' + stage;
  const queueKey = 'jjfz-course-player:queue:' + stage;
  const approvedKey = 'approved:' + page.origin;
  const muteKey = 'muted:' + page.origin;
  const resumeLoadGraceMs = 3500; // 网站最多等 3 秒读取断点
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

  function siteUrl(href, expectedPath, base = page) {
    if (!href || !URL.canParse(href, base)) return null;
    const url = new URL(href, base);
    return url.origin === page.origin && !url.username && !url.password
      && url.pathname.replace(/\/$/, '') === expectedPath && url.searchParams.get('stg') === stage
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
    return expected.searchParams.get('v_id') === actual.searchParams.get('v_id')
      && (!episode || episode === actual.searchParams.get('r_id'));
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

  async function startQueue(rebuild = false) {
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
      queue = { entries, index: 0, running: true };
      resumeQueue();
    } catch (error) {
      showStatus(`队列未启动：${error.message} 可在油猴菜单重试。`);
    } finally {
      building = false;
    }
  }

  function findContinueButton() {
    for (const overlay of document.body.children) {
      // 两种提示由同一个播放器弹窗函数生成。
      if (overlay.style.zIndex !== '2147483000' || !overlay.getClientRects().length) continue;

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

  function advanceAfterCompletion(video) {
    if (advanced || !video?.ended) return;

    const confirmed = [...document.querySelectorAll('.layui-layer-dialog .layui-layer-content')]
      .some(dialog => dialog.getClientRects().length && dialog.textContent.trim() === '当前视频播放完毕！');
    if (!confirmed) return;
    advanced = true;

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

  function update() {
    if (!enabled || document.hidden) return;

    const video = findVideo();
    if (muted && video && mutedVideo !== video) {
      video.muted = true;
      mutedVideo = video;
    }

    const button = findContinueButton();
    if (button) {
      startRequested = false;
      if (!handledButtons.has(button)) {
        handledButtons.add(button);
        button.click();
      }
      return;
    }

    advanceAfterCompletion(video);
    if (queue?.running && video?.ended && !advanced) {
      showStatus(describeQueue() + ' · 等待网站完成回执');
    }
    if (!startRequested || startTimer !== null || !video || video.readyState < 1) return;

    startTimer = setTimeout(async () => {
      startTimer = null;
      if (!enabled || !startRequested || document.hidden) return;
      if (!video.isConnected || findContinueButton()) {
        update();
        return;
      }
      startRequested = false;
      if (!video.paused || video.ended) return;

      try {
        await video.play();
      } catch (error) {
        if (error.name !== 'NotAllowedError' || !enabled || document.hidden
          || !video.isConnected || findContinueButton()) return;

        const wasMuted = video.muted;
        video.muted = true;
        try {
          await video.play();
        } catch {
          video.muted = wasMuted;
          console.info('[培训视频续播] Chrome 拦截了自动播放，请手动点一次播放。');
        }
      }
    }, resumeLoadGraceMs);
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

  function findVideo() {
    const videos = document.querySelectorAll('video');
    return videos.length === 1 ? videos[0] : document.querySelector('.xgplayer video');
  }

  GM_registerMenuCommand('静音播放（记住此站点）', () => setMute(true));
  GM_registerMenuCommand('恢复声音（记住此站点）', () => setMute(false));

  if (path === centerPath) {
    GM_registerMenuCommand('开始或继续全部必修视频', () => startQueue());
    if (queue?.entries[queue.index]) {
      GM_registerMenuCommand('重新读取必修目录并开始', () => startQueue(true));
    }
    if (queue) showStatus(describeQueue());
    return;
  }

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
    clearTimeout(startTimer);
    startTimer = null;
    if (queue?.running) {
      queue.running = false;
      saveQueue();
      showStatus(describeQueue());
    }
  });

  if (queue?.entries[queue.index] && isCurrentVideo(queue.entries[queue.index])) showStatus(describeQueue());
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('loadedmetadata', update, true);
  document.addEventListener('ended', update, true);
  document.addEventListener('visibilitychange', update);
  update();
})();
