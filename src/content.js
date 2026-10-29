/*
 * Isolated-world content script.
 *
 * Responsibilities:
 *  - detect GCORES radio routes and react to SPA navigation;
 *  - reuse page API responses captured by the MAIN-world bridge, and fetch
 *    only the data the page did not already load;
 *  - merge editorial timeline entries with timestamped comments;
 *  - render accessible marker buttons on the player timeline;
 *  - show a preview on hover/focus and seek on click without starting playback.
 */
(function initGcoresTimelineContent() {
  'use strict';

  const GTC = globalThis.GTC;
  if (!GTC) return;

  const API_BASE = 'https://www.gcores.com/gapi/v1';
  const CACHE_TTL = 2 * 60 * 1000;
  const CAPTURE_TTL = 10 * 60 * 1000;
  const MAX_CAPTURES = 8;
  const CLUSTER_PX = 12;
  // GCORES draws the official timeline at a fixed 100 px per minute, even
  // though the scroll track also reserves one viewport of trailing padding.
  // Using a percentage of that padded track drifts further behind the official
  // chapter anchors as the programme progresses.
  const TIMELINE_PX_PER_SECOND = 5 / 3;

  const state = {
    href: location.href,
    programmeId: null,
    token: 0,
    loading: false,
    entries: [],
    duration: 0,
    title: '',
    layers: [],
    layerBySlider: new WeakMap(),
    cache: new Map(),
    capturedRadio: new Map(),
    capturedComments: new Map(),
    audio: null,
    audioHandler: null,
    playedRaf: 0,
    layoutRaf: 0,
    routeTimer: 0,
    mutationTimer: 0,
    observer: null,
    observerTarget: null,
    tooltipEl: null,
    tooltipMarker: null,
    tooltipCluster: null,
    tooltipHideTimer: 0,
    tooltipFadeTimer: 0,
    tooltipRaf: 0,
    toastEl: null,
    toastTimer: 0,
    toastMessage: '',
    currentTime: 0,
    fullscreenRoot: null,
  };

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function pruneMap(map, max) {
    while (map.size > max) {
      map.delete(map.keys().next().value);
    }
  }

  function programmeIdFromPath() {
    const match = location.pathname.match(/^\/radios\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------

  function commentsUrl(id, offset) {
    // The page's “时刻” tab uses this filter; asking for it directly keeps the
    // whole paginated set to timestamped comments instead of paging through
    // every ordinary comment looking for the few timed ones.
    return `${API_BASE}/radios/${id}/comments?page%5Blimit%5D=100&page%5Boffset%5D=${offset}&sort=radio-timestamp&include=user&filter%5Btimed%5D=1`;
  }

  function radioUrl(id) {
    return `${API_BASE}/radios/${id}?include=media%2Cmedia.timelines`;
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        credentials: 'include',
        cache: 'default',
        headers: { Accept: 'application/vnd.api+json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ApiError(`HTTP ${response.status}`, response.status);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchWithOneRetry(url) {
    try {
      return await fetchJson(url);
    } catch (error) {
      if (error.status === 429 || error.status === 403 || error.status === 404) {
        throw error;
      }
      await sleep(650);
      return fetchJson(url);
    }
  }

  function usableRadioPayload(payload) {
    return Boolean(payload && payload.data && Array.isArray(payload.included));
  }

  async function fetchTimestampedComments(id) {
    let offset = 0;
    const combined = { data: [], included: [], meta: null };
    const seenComments = new Set();
    const seenUsers = new Set();

    let recordCount = null;
    for (let page = 0; page < 50; page += 1) {
      const payload = await fetchWithOneRetry(commentsUrl(id, offset));
      const data = Array.isArray(payload.data) ? payload.data : [];
      const included = Array.isArray(payload.included) ? payload.included : [];

      for (const item of data) {
        if (!item || seenComments.has(String(item.id))) continue;
        seenComments.add(String(item.id));
        combined.data.push(item);
      }
      for (const item of included) {
        if (!item || seenUsers.has(String(item.id))) continue;
        seenUsers.add(String(item.id));
        combined.included.push(item);
      }
      if (payload.meta) {
        combined.meta = payload.meta;
        const count = Number(payload.meta['record-count']);
        if (Number.isFinite(count) && count >= 0) recordCount = count;
      }

      if (data.length < 100) break;
      const pageHasTimestamp = data.some(
        (item) =>
          item &&
          item.attributes &&
          GTC.parseTimestamp(item.attributes['radio-timestamp']) !== null
      );
      if (!pageHasTimestamp) break;
      offset += 100;
      if (recordCount !== null && offset >= recordCount) break;
    }
    return combined;
  }

  function captureRadio(id, payload) {
    if (!usableRadioPayload(payload)) return;
    state.capturedRadio.set(id, { payload, t: Date.now() });
    pruneMap(state.capturedRadio, MAX_CAPTURES);
  }

  function captureComments(id, payload, url) {
    // The ordinary comments list is sorted by score and only contains ten
    // entries per page. Reusing it made the marker set depend on whether the
    // page happened to have loaded a few timed comments before us. Only accept
    // a complete “时刻” response (filter[timed]=1, offset 0, all records).
    let complete = false;
    try {
      const parsed = new URL(url, location.href);
      const timed = parsed.searchParams.get('filter[timed]') === '1';
      const offset = Number(parsed.searchParams.get('page[offset]') || 0);
      const count = Number(payload && payload.meta && payload.meta['record-count']);
      const length = Array.isArray(payload && payload.data) ? payload.data.length : 0;
      complete =
        timed &&
        offset === 0 &&
        Number.isFinite(count) &&
        count >= 0 &&
        length >= count;
    } catch (_error) {
      return;
    }
    if (!complete) return;
    state.capturedComments.set(id, { payload, t: Date.now() });
    pruneMap(state.capturedComments, MAX_CAPTURES);
  }

  function getCapture(map, id) {
    const record = map.get(id);
    if (!record) return null;
    if (Date.now() - record.t > CAPTURE_TTL) {
      map.delete(id);
      return null;
    }
    return record.payload;
  }

  // ---------------------------------------------------------------------------
  // Route and load lifecycle
  // ---------------------------------------------------------------------------

  function scheduleRouteCheck(delay) {
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(() => checkRoute(false), Number.isFinite(delay) ? delay : 60);
  }

  function resetForNoRadio() {
    state.token += 1;
    state.loading = false;
    state.programmeId = null;
    state.entries = [];
    state.duration = 0;
    state.title = '';
    teardownLayers();
    hideTooltip();
    hideToast();
  }

  function checkRoute(force) {
    const href = location.href;
    if (!force && href === state.href) {
      if (state.programmeId && state.entries.length) ensureAttached();
      return;
    }
    state.href = href;

    const id = programmeIdFromPath();
    if (!id) {
      resetForNoRadio();
      return;
    }

    if (!force && id === state.programmeId) {
      if (state.entries.length) ensureAttached();
      return;
    }

    // Drop the previous programme's markers before the new data arrives so an
    // SPA switch can never relabel stale comments onto the next player.
    state.entries = [];
    state.duration = 0;
    teardownLayers();
    hideTooltip();
    hideToast();
    state.programmeId = id;
    loadProgramme(id, { force: Boolean(force) });
  }

  async function loadProgramme(id, options) {
    const token = ++state.token;
    const force = Boolean(options && options.force);
    state.loading = true;
    state.entries = [];
    state.duration = 0;
    state.title = '';
    teardownLayers();
    hideTooltip();
    hideToast();

    if (force) state.cache.delete(id);

    const cached = state.cache.get(id);
    if (cached && Date.now() - cached.t < CACHE_TTL) {
      state.loading = false;
      applyProgramme({
        id,
        entries: cached.entries,
        duration: cached.duration,
        title: cached.title,
        token,
        failure: null,
      });
      return;
    }

    const capturedRadio = getCapture(state.capturedRadio, id);
    const capturedComments = getCapture(state.capturedComments, id);

    const radioTask = capturedRadio
      ? Promise.resolve({ ok: true, payload: capturedRadio, error: null })
      : fetchWithOneRetry(radioUrl(id)).then(
          (payload) => ({ ok: true, payload, error: null }),
          (error) => ({ ok: false, payload: null, error })
        );

    const commentsTask = capturedComments
      ? Promise.resolve({ ok: true, payload: capturedComments, error: null })
      : fetchTimestampedComments(id).then(
          (payload) => ({ ok: true, payload, error: null }),
          (error) => ({ ok: false, payload: null, error })
        );

    const [radioOutcome, commentsOutcome] = await Promise.all([radioTask, commentsTask]);
    if (token !== state.token) return;
    state.loading = false;

    const radioPayload = radioOutcome.ok ? radioOutcome.payload : null;
    const commentsPayload = commentsOutcome.ok ? commentsOutcome.payload : null;
    const radioEntries = radioPayload ? GTC.extractTimelineEntries(radioPayload) : [];
    const commentEntries = commentsPayload ? GTC.extractTimestampedComments(commentsPayload) : [];
    const apiDuration = radioPayload ? GTC.extractDuration(radioPayload) : 0;
    // Markers represent comments only. The official chapter strip already
    // displays editorial timeline entries; duplicating those as dots made the
    // strip noisy and obscured the comment positions we actually care about.
    const merged = GTC.mergeEntries(commentEntries, apiDuration);
    const failure = !radioOutcome.ok
      ? radioOutcome.error
      : !commentsOutcome.ok
        ? commentsOutcome.error
        : null;

    const title =
      (radioPayload && radioPayload.data && radioPayload.data.attributes
        ? radioPayload.data.attributes.title
        : '') || '';

    applyProgramme({
      id,
      entries: merged,
      duration: apiDuration,
      title,
      token,
      failure,
    });

    if (merged.length === 0) {
      showToast(
        failure ? failureMessage(failure) : '本节目还没有带时间戳的评论，播放器照常使用。',
        {
          type: failure ? 'error' : 'info',
          action: failure ? () => retryProgramme(id) : null,
          duration: failure ? 8000 : 5000,
        }
      );
    } else if (failure && commentEntries.length === 0 && radioEntries.length > 0) {
      showToast('时间戳评论暂时没加载出来，节目标记仍然可用。', {
        type: 'error',
        action: () => retryProgramme(id),
        duration: 8000,
      });
    }
  }

  function retryProgramme(id) {
    if (state.programmeId !== id) return;
    hideToast();
    loadProgramme(id, { force: true });
  }

  function failureMessage(error) {
    if (!error) return '时间戳评论加载失败，播放器仍可正常使用。';
    if (error.status === 429) return '请求被限流了，稍等一会儿再试试；播放器不受影响。';
    if (error.status === 403) return '没有取到评论数据，播放器仍可正常使用。';
    if (error.status === 404) return '没有找到这个节目的数据，播放器仍可正常使用。';
    if (error.name === 'AbortError') return '加载超时了，播放器仍可正常使用。';
    return '时间戳评论加载失败，播放器仍可正常使用。';
  }

  function applyProgramme(result) {
    if (result.token !== state.token) return;

    const audio = getAudio();
    const audioDuration =
      audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const maxAt = result.entries.reduce(
      (maximum, entry) => Math.max(maximum, Number(entry.at) || 0),
      0
    );
    const duration =
      result.duration || audioDuration || (maxAt > 0 ? Math.max(3600, Math.ceil(maxAt + 60)) : 0);

    state.entries = result.entries;
    state.duration = duration;
    state.title = result.title || '';
    state.currentTime = currentPlaybackTime();
    state.cache.set(result.id, {
      entries: result.entries,
      duration,
      title: state.title,
      t: Date.now(),
    });
    pruneMap(state.cache, MAX_CAPTURES);

    bindAudio();
    ensureAttached();
    scheduleLayout(0);
    updatePlayedState();
  }

  // ---------------------------------------------------------------------------
  // Timeline marker layer
  // ---------------------------------------------------------------------------

  function isVisibleElement(element) {
    if (!element || !element.isConnected) return false;
    let rect;
    try {
      rect = element.getBoundingClientRect();
    } catch (_error) {
      return false;
    }
    if (rect.width < 12 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  function isProgressSlider(element) {
    const label = (element.getAttribute('aria-label') || '').replace(/\s+/g, '');
    if (/音量|声音|volume/i.test(label)) return false;
    if (/进度|播放/.test(label)) return true;
    // Some fullscreen layouts only expose the wrapper class.
    return Boolean(element.closest('.playerFullscreenProgress, .playerFullscreenProgress-phone'));
  }

  function sliderCandidates() {
    const selector = '.controlledProgressBar[role="slider"], [role="slider"][aria-label*="进度"]';
    const result = [];
    const seen = new Set();
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element) || !isProgressSlider(element) || !isVisibleElement(element)) continue;
      seen.add(element);
      result.push(element);
    }
    return result;
  }

  /**
   * The official chapter strip is a wide, horizontally-scrolling timeline.
   * Its anchors already use the same seconds-to-pixels scale as the API
   * timeline entries, so a layer inside its inner track stays aligned while
   * the strip auto-scrolls.
   */
  function timelineTrackCandidates() {
    const result = [];
    const seen = new Set();
    for (const element of document.querySelectorAll(
      '.playerFullscreenTimelineProgress_bar'
    )) {
      if (seen.has(element) || !isVisibleElement(element)) continue;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 100) || !(rect.height > 0)) continue;
      seen.add(element);
      result.push(element);
    }
    return result;
  }

  function markerTargets() {
    const tracks = timelineTrackCandidates();
    if (tracks.length) {
      return tracks.map((element) => ({ element, kind: 'timeline' }));
    }
    return sliderCandidates().map((element) => ({ element, kind: 'progress' }));
  }

  function teardownLayers() {
    for (const layer of state.layers.slice()) {
      detachLayer(layer);
    }
    state.layers = [];
  }

  function detachLayer(layer) {
    if (layer.resizeObserver) layer.resizeObserver.disconnect();
    if (layer.el) layer.el.remove();
    if (layer.host) {
      if (layer.changedPosition) {
        if (layer.previousPosition) layer.host.style.position = layer.previousPosition;
        else layer.host.style.removeProperty('position');
      }
      if (layer.changedOverflow) {
        if (layer.previousOverflow) layer.host.style.overflow = layer.previousOverflow;
        else layer.host.style.removeProperty('overflow');
      }
      layer.host.removeAttribute('data-gtc-host');
    }
    if (state.layerBySlider.get(layer.slider) === layer) {
      state.layerBySlider.delete(layer.slider);
    }
  }

  function attachLayer(target) {
    const slider = target.element;
    const kind = target.kind;
    const existing = state.layerBySlider.get(slider);
    if (existing && existing.el && existing.el.isConnected) return existing;

    const host = kind === 'timeline' ? slider : slider.parentElement;
    if (!host) return null;

    const hostStyle = getComputedStyle(host);
    const previousPosition = host.style.position;
    const previousOverflow = host.style.overflow;
    const changedPosition = hostStyle.position === 'static';
    if (changedPosition) host.style.position = 'relative';
    // The timeline track owns its clipping and horizontal scroll. Never
    // override those styles; only the short progress slider needs visible
    // overflow for the marker dots.
    const changedOverflow =
      kind !== 'timeline' &&
      (hostStyle.overflow === 'hidden' || hostStyle.overflowX === 'hidden');
    if (changedOverflow) host.style.overflow = 'visible';
    host.setAttribute('data-gtc-host', '1');

    const layerEl = document.createElement('div');
    layerEl.className = kind === 'timeline' ? 'gtc-layer gtc-layer--timeline' : 'gtc-layer';
    layerEl.setAttribute('role', 'group');
    layerEl.setAttribute('aria-label', '带时间戳的评论标记');

    const layer = {
      el: layerEl,
      kind,
      slider,
      host,
      buttons: [],
      clusters: [],
      signature: '',
      changedPosition,
      previousPosition,
      changedOverflow,
      previousOverflow,
      resizeObserver: null,
    };

    const resizeObserver = new ResizeObserver(() => scheduleLayout(0));
    resizeObserver.observe(host);
    resizeObserver.observe(slider);
    layer.resizeObserver = resizeObserver;

    host.appendChild(layerEl);
    state.layerBySlider.set(slider, layer);
    return layer;
  }

  function ensureAttached() {
    if (!state.programmeId || state.entries.length === 0) return;
    const targets = markerTargets();
    const active = [];

    for (const target of targets) {
      let layer = state.layerBySlider.get(target.element);
      if (!layer || !layer.el || !layer.el.isConnected) {
        layer = attachLayer(target);
      }
      if (layer && !active.includes(layer)) active.push(layer);
    }

    for (const layer of state.layers) {
      if (!active.includes(layer)) detachLayer(layer);
    }
    state.layers = active;
    scheduleLayout(0);
  }

  function scheduleLayout(delay) {
    if (state.layoutRaf) cancelAnimationFrame(state.layoutRaf);
    state.layoutRaf = requestAnimationFrame(() => {
      state.layoutRaf = 0;
      if (delay) {
        setTimeout(layoutLayers, delay);
      } else {
        layoutLayers();
      }
    });
  }

  function layoutLayers() {
    if (!state.entries.length) return;
    const current = currentPlaybackTime();
    state.currentTime = current;

    for (const layer of state.layers) {
      if (!layer.el || !layer.el.isConnected) continue;
      const width = layer.host.clientWidth || layer.slider.getBoundingClientRect().width;
      if (!width) continue;
      // The official track reserves trailing padding for scrolling, so group
      // markers against the chapter extent rather than the padded track width.
      const layoutWidth =
        layer.kind === 'timeline'
          ? Math.max(1, state.duration * TIMELINE_PX_PER_SECOND)
          : width;

      const entries = state.entries;
      const clusters = GTC.groupEntries(
        entries,
        state.duration,
        layoutWidth,
        CLUSTER_PX
      );
      const signature = `${layer.kind}|${Math.round(width)}|${Math.round(
        state.duration * 10
      )}|${clusters
        .map((cluster) => `${cluster.at}:${cluster.entries.length}`)
        .join(',')}`;

      if (signature !== layer.signature) {
        if (state.tooltipMarker && layer.el.contains(state.tooltipMarker)) {
          hideTooltip();
        }
        layer.el.replaceChildren();
        layer.buttons = clusters.map((cluster) => createMarker(cluster));
        for (const button of layer.buttons) layer.el.appendChild(button);
        layer.clusters = clusters;
        layer.signature = signature;
      }

      updateLayerPositions(layer);
      updateLayerPlayed(layer, current);
    }
  }

  function markerPercent(at) {
    if (!(state.duration > 0)) return 0;
    return clamp((Number(at) / state.duration) * 100, 0, 100);
  }

  function updateLayerPositions(layer) {
    for (let index = 0; index < layer.buttons.length; index += 1) {
      const button = layer.buttons[index];
      const cluster = layer.clusters[index];
      if (!button || !cluster) continue;
      if (layer.kind === 'timeline') {
        const at = clamp(Number(cluster.at) || 0, 0, state.duration || 0);
        button.style.left = `${(at * TIMELINE_PX_PER_SECOND).toFixed(2)}px`;
      } else {
        button.style.left = `${markerPercent(cluster.at).toFixed(4)}%`;
      }
    }
  }

  function updateLayerPlayed(layer, current) {
    for (let index = 0; index < layer.buttons.length; index += 1) {
      const button = layer.buttons[index];
      const cluster = layer.clusters[index];
      if (!button || !cluster) continue;
      button.classList.toggle('is-played', cluster.at <= current + 0.05);
    }
  }

  function createMarker(cluster) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gtc-marker';
    if (cluster.entries.length > 1) button.classList.add('gtc-marker--group');
    button.setAttribute('aria-label', GTC.clusterAccessibleLabel(cluster));
    button.setAttribute('data-gtc-at', String(cluster.at));
    if (cluster.entries.length > 1) button.dataset.gtcCount = String(cluster.entries.length);

    const dot = document.createElement('span');
    dot.className = 'gtc-marker__dot';
    dot.setAttribute('aria-hidden', 'true');
    button.appendChild(dot);

    if (cluster.entries.length > 1) {
      const count = document.createElement('span');
      count.className = 'gtc-marker__count';
      count.setAttribute('aria-hidden', 'true');
      count.textContent = String(cluster.entries.length);
      button.appendChild(count);
    }

    button.addEventListener('pointerenter', () => showTooltip(button, cluster));
    button.addEventListener('pointerleave', scheduleHideTooltip);
    button.addEventListener('focus', () => showTooltip(button, cluster));
    button.addEventListener('blur', scheduleHideTooltip);
    button.addEventListener('pointerdown', stopPlayerGesture);
    button.addEventListener('mousedown', stopPlayerGesture);
    button.addEventListener('touchstart', stopPlayerGesture, { passive: true });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      seekTo(cluster.at);
      showTooltip(button, cluster);
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideTooltip();
        button.blur();
      }
    });

    return button;
  }

  function stopPlayerGesture(event) {
    event.stopPropagation();
  }

  // ---------------------------------------------------------------------------
  // Playback state and seeking
  // ---------------------------------------------------------------------------

  function getAudio() {
    const primary = document.querySelector('#gcores-player-media');
    if (primary && primary.isConnected) return primary;
    const candidates = Array.from(document.querySelectorAll('audio')).filter((audio) => {
      return audio.isConnected && (audio.currentSrc || audio.src || Number.isFinite(audio.duration));
    });
    return candidates[0] || null;
  }

  function currentPlaybackTime() {
    const audio = getAudio();
    if (audio && Number.isFinite(audio.currentTime)) return audio.currentTime;
    const slider = sliderCandidates()[0];
    if (slider && state.duration > 0) {
      const value = Number(slider.getAttribute('aria-valuenow'));
      if (Number.isFinite(value)) return (value / 100) * state.duration;
    }
    return 0;
  }

  function bindAudio() {
    const audio = getAudio();
    if (!audio) return;
    if (state.audio === audio && state.audioHandler) return;

    if (state.audio && state.audioHandler) {
      state.audio.removeEventListener('timeupdate', state.audioHandler);
      state.audio.removeEventListener('seeking', state.audioHandler);
      state.audio.removeEventListener('seeked', state.audioHandler);
      state.audio.removeEventListener('durationchange', state.audioHandler);
      state.audio.removeEventListener('loadedmetadata', state.audioHandler);
      state.audio.removeEventListener('play', state.audioHandler);
      state.audio.removeEventListener('pause', state.audioHandler);
    }

    state.audio = audio;
    state.audioHandler = () => handleMediaUpdate();
    audio.addEventListener('timeupdate', state.audioHandler);
    audio.addEventListener('seeking', state.audioHandler);
    audio.addEventListener('seeked', state.audioHandler);
    audio.addEventListener('durationchange', state.audioHandler);
    audio.addEventListener('loadedmetadata', state.audioHandler);
    audio.addEventListener('play', state.audioHandler);
    audio.addEventListener('pause', state.audioHandler);
    handleMediaUpdate();
  }

  function handleMediaUpdate() {
    if (state.playedRaf) return;
    state.playedRaf = requestAnimationFrame(() => {
      state.playedRaf = 0;
      const audio = state.audio || getAudio();
      if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
        if (Math.abs(audio.duration - state.duration) > 0.5) {
          state.duration = audio.duration;
          const cached = state.programmeId ? state.cache.get(state.programmeId) : null;
          if (cached) {
            cached.duration = audio.duration;
            cached.t = Date.now();
          }
          scheduleLayout(0);
        }
      }
      updatePlayedState();
    });
  }

  function updatePlayedState() {
    if (!state.entries.length) return;
    const current = currentPlaybackTime();
    state.currentTime = current;
    for (const layer of state.layers) {
      updateLayerPlayed(layer, current);
    }
  }

  function seekTo(seconds) {
    const audio = getAudio();
    if (!audio) {
      showToast('播放器还没准备好，先点一下播放再试试。', { type: 'info', duration: 4000 });
      return;
    }
    const duration =
      Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : state.duration;
    const target = clamp(Number(seconds) || 0, 0, duration > 0 ? duration : Number(seconds) || 0);
    try {
      // Do not call play(): setting currentTime on a paused element keeps it paused.
      audio.currentTime = target;
      state.currentTime = target;
      updatePlayedState();
    } catch (_error) {
      showToast('跳转失败，播放器可能还没有加载好。', { type: 'error', duration: 5000 });
    }
  }

  // ---------------------------------------------------------------------------
  // Tooltip preview
  // ---------------------------------------------------------------------------

  function portalRoot() {
    return document.fullscreenElement || document.body;
  }

  function ensureTooltip() {
    if (state.tooltipEl && state.tooltipEl.isConnected) return state.tooltipEl;
    const el = document.createElement('div');
    el.className = 'gtc-tooltip';
    el.id = 'gtc-tooltip';
    el.setAttribute('role', 'tooltip');
    el.hidden = true;
    el.addEventListener('pointerenter', () => clearTimeout(state.tooltipHideTimer));
    el.addEventListener('pointerleave', scheduleHideTooltip);
    portalRoot().appendChild(el);
    state.tooltipEl = el;
    return el;
  }

  function buildTooltipContent(cluster) {
    const fragment = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'gtc-tooltip__head';

    const time = document.createElement('span');
    time.className = 'gtc-tooltip__time';
    time.textContent = GTC.formatTime(cluster.at);
    head.appendChild(time);

    const badge = document.createElement('span');
    badge.className = 'gtc-tooltip__badge';
    badge.textContent =
      cluster.entries.length > 1 ? `${cluster.entries.length} 条` : cluster.entries[0].kind === 'comment' ? '评论' : '时间轴';
    head.appendChild(badge);
    fragment.appendChild(head);

    if (cluster.entries.length > 1) {
      const hint = document.createElement('div');
      hint.className = 'gtc-tooltip__hint';
      hint.textContent = '时间相近，点击跳到最早一条';
      fragment.appendChild(hint);
    }

    const list = document.createElement('div');
    list.className = 'gtc-tooltip__list';
    for (const entry of cluster.entries.slice(0, 5)) {
      const row = document.createElement('div');
      row.className = 'gtc-tooltip__entry';

      const meta = document.createElement('div');
      meta.className = 'gtc-tooltip__meta';
      const entryTime = document.createElement('span');
      entryTime.className = 'gtc-tooltip__entry-time';
      entryTime.textContent = GTC.formatTime(entry.at);
      if (cluster.entries.length > 1) meta.appendChild(entryTime);

      const kind = document.createElement('span');
      kind.className = 'gtc-tooltip__kind';
      kind.textContent =
        entry.kind === 'comment' ? (entry.author ? `@${entry.author}` : '评论') : '时间轴';
      meta.appendChild(kind);
      row.appendChild(meta);

      if (entry.kind === 'timeline' && entry.title) {
        const title = document.createElement('div');
        title.className = 'gtc-tooltip__title';
        title.textContent = entry.title;
        row.appendChild(title);
      }

      const content = document.createElement('div');
      content.className = 'gtc-tooltip__content';
      content.textContent = entry.content || '（没有正文）';
      row.appendChild(content);
      list.appendChild(row);
    }
    fragment.appendChild(list);

    if (cluster.entries.length > 5) {
      const more = document.createElement('div');
      more.className = 'gtc-tooltip__more';
      more.textContent = `还有 ${cluster.entries.length - 5} 条时间相近的评论`;
      fragment.appendChild(more);
    }

    const foot = document.createElement('div');
    foot.className = 'gtc-tooltip__foot';
    foot.textContent = cluster.entries.length > 1 ? '点击跳转到最早一条' : '点击跳转到该时间';
    fragment.appendChild(foot);
    return fragment;
  }

  function showTooltip(marker, cluster) {
    if (!marker || !cluster) return;
    clearTimeout(state.tooltipHideTimer);
    clearTimeout(state.tooltipFadeTimer);
    const el = ensureTooltip();
    if (state.tooltipMarker && state.tooltipMarker !== marker) {
      state.tooltipMarker.removeAttribute('aria-describedby');
    }
    state.tooltipMarker = marker;
    state.tooltipCluster = cluster;
    el.replaceChildren(buildTooltipContent(cluster));
    el.hidden = false;
    el.classList.remove('is-visible');
    el.style.visibility = 'hidden';
    marker.setAttribute('aria-describedby', 'gtc-tooltip');
    state.tooltipRaf = requestAnimationFrame(() => {
      state.tooltipRaf = 0;
      if (!el || el.hidden) return;
      positionTooltip();
      el.style.visibility = '';
      // Flush the opacity:0 state before adding the visible class so the
      // preview fades in as well as out.
      void el.offsetWidth;
      el.classList.add('is-visible');
    });
  }

  function scheduleHideTooltip() {
    clearTimeout(state.tooltipHideTimer);
    state.tooltipHideTimer = setTimeout(hideTooltip, 160);
  }

  function onPointerMove(event) {
    if (!state.tooltipMarker) return;
    const marker = state.tooltipMarker;
    if (!marker.isConnected) {
      scheduleHideTooltip();
      return;
    }
    const rect = marker.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      scheduleHideTooltip();
    }
  }

  function hideTooltip() {
    clearTimeout(state.tooltipHideTimer);
    if (state.tooltipRaf) {
      cancelAnimationFrame(state.tooltipRaf);
      state.tooltipRaf = 0;
    }
    if (state.tooltipMarker) state.tooltipMarker.removeAttribute('aria-describedby');
    state.tooltipMarker = null;
    state.tooltipCluster = null;
    if (state.tooltipEl) {
      const el = state.tooltipEl;
      el.classList.remove('is-visible');
      clearTimeout(state.tooltipFadeTimer);
      state.tooltipFadeTimer = setTimeout(() => {
        state.tooltipFadeTimer = 0;
        if (state.tooltipEl === el && !el.classList.contains('is-visible')) {
          el.hidden = true;
          el.style.visibility = '';
        }
      }, 160);
    }
  }

  function scheduleTooltipPosition() {
    if (!state.tooltipEl || state.tooltipEl.hidden || state.tooltipRaf) return;
    state.tooltipRaf = requestAnimationFrame(() => {
      state.tooltipRaf = 0;
      positionTooltip();
    });
  }

  function positionTooltip() {
    const el = state.tooltipEl;
    const marker = state.tooltipMarker;
    if (!el || el.hidden || !marker || !marker.isConnected) return;
    const markerRect = marker.getBoundingClientRect();
    if (markerRect.bottom < 0 || markerRect.top > window.innerHeight) {
      hideTooltip();
      return;
    }
    const tooltipRect = el.getBoundingClientRect();
    const margin = 8;
    const gap = 10;
    let left = markerRect.left + markerRect.width / 2 - tooltipRect.width / 2;
    left = clamp(left, margin, Math.max(margin, window.innerWidth - tooltipRect.width - margin));

    let top = markerRect.top - tooltipRect.height - gap;
    let placement = 'top';
    if (top < margin) {
      top = markerRect.bottom + gap;
      placement = 'bottom';
    }
    if (top + tooltipRect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - tooltipRect.height - margin);
      placement = 'top';
    }

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.placement = placement;
  }

  // ---------------------------------------------------------------------------
  // Non-intrusive status toast
  // ---------------------------------------------------------------------------

  function ensureToast() {
    if (state.toastEl && state.toastEl.isConnected) return state.toastEl;
    const el = document.createElement('div');
    el.className = 'gtc-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    portalRoot().appendChild(el);
    state.toastEl = el;
    return el;
  }

  function showToast(message, options) {
    const settings = options || {};
    if (!message) return;
    if (state.toastMessage === message && state.toastEl && !state.toastEl.hidden) {
      clearTimeout(state.toastTimer);
      state.toastTimer = setTimeout(hideToast, settings.duration || 5000);
      return;
    }

    const el = ensureToast();
    clearTimeout(state.toastTimer);
    state.toastMessage = message;
    el.className = `gtc-toast${settings.type === 'error' ? ' gtc-toast--error' : ''}`;
    el.replaceChildren();

    const text = document.createElement('span');
    text.className = 'gtc-toast__text';
    text.textContent = message;
    el.appendChild(text);

    if (typeof settings.action === 'function') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gtc-toast__action';
      button.textContent = '重试';
      button.addEventListener('click', () => {
        hideToast();
        settings.action();
      });
      el.appendChild(button);
    }

    el.hidden = false;
    state.toastTimer = setTimeout(hideToast, settings.duration || 5000);
  }

  function hideToast() {
    clearTimeout(state.toastTimer);
    state.toastMessage = '';
    if (state.toastEl) state.toastEl.hidden = true;
  }

  function repositionPortals() {
    const root = portalRoot();
    if (state.tooltipEl) root.appendChild(state.tooltipEl);
    if (state.toastEl) root.appendChild(state.toastEl);
    if (state.tooltipMarker) scheduleTooltipPosition();
  }

  // ---------------------------------------------------------------------------
  // DOM observation and lifecycle
  // ---------------------------------------------------------------------------

  function ensureObserver() {
    const target = document.querySelector('#app') || document.body;
    if (!target) return;
    if (state.observer && state.observerTarget === target && target.isConnected) return;
    if (state.observer) state.observer.disconnect();

    const observer = new MutationObserver((mutations) => {
      let relevant = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.closest && node.closest('.gtc-layer, .gtc-tooltip, .gtc-toast')) continue;
          relevant = true;
          break;
        }
        if (relevant) break;
      }
      if (!relevant) return;
      clearTimeout(state.mutationTimer);
      state.mutationTimer = setTimeout(() => {
        checkRoute(false);
        if (state.programmeId && state.entries.length) ensureAttached();
        if (state.tooltipMarker) scheduleTooltipPosition();
      }, 180);
    });

    observer.observe(target, { childList: true, subtree: true });
    state.observer = observer;
    state.observerTarget = target;
  }

  function onApiData(event) {
    if (typeof event.detail !== 'string') return;
    let packet;
    try {
      packet = JSON.parse(event.detail);
    } catch (_error) {
      return;
    }
    if (!packet || typeof packet.url !== 'string' || !packet.data) return;
    const match = packet.url.match(/\/gapi\/v1\/radios\/(\d+)(\/comments)?(?:[?#]|$)/);
    if (!match) return;
    const id = match[1];
    if (match[2]) captureComments(id, packet.data, packet.url);
    else captureRadio(id, packet.data);
  }

  function onLocationEvent() {
    scheduleRouteCheck(40);
  }

  function onFullscreenChange() {
    repositionPortals();
    ensureAttached();
    scheduleLayout(0);
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    checkRoute(false);
    bindAudio();
    if (state.programmeId && state.entries.length) ensureAttached();
  }

  function tick() {
    if (document.visibilityState === 'hidden') return;
    checkRoute(false);
    ensureObserver();
    bindAudio();
    if (state.programmeId && state.entries.length) ensureAttached();
    if (state.tooltipMarker) scheduleTooltipPosition();
  }

  function init() {
    window.addEventListener('gtc:api-data', onApiData);
    window.addEventListener('gtc:location', onLocationEvent);
    window.addEventListener('resize', () => {
      scheduleLayout(0);
      scheduleTooltipPosition();
    });
    window.addEventListener('scroll', scheduleTooltipPosition, true);
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('visibilitychange', onVisibilityChange);

    ensureObserver();
    checkRoute(true);
    bindAudio();
    setInterval(tick, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
