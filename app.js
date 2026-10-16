(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { catalog: null, book: null, index: 0, focus: 0, requested: null, mobile: false, plain: false, scale: 1, panX: 0, panY: 0, pointers: new Map(), pinch: null, drag: null, rebuilding: false };
  let motionChoice = 'full';
  const mobileQuery = window.matchMedia('(max-width: 760px)');
  const dialogs = ['contents-dialog', 'detail-dialog', 'qr-dialog'];
  let resizeTimer, toastTimer, observer;

  function motionEnabled() {
    return motionChoice === 'full';
  }
  function reflectMotion() {
    const enabled = motionEnabled();
    $('motion-toggle').setAttribute('aria-pressed', String(enabled));
    $('motion-toggle').title = enabled ? 'Animasyonu kapat ve sayfaları doğrudan değiştir' : 'Dergi gibi kıvrılan sayfa animasyonunu aç';
    $('motion-label').textContent = enabled ? 'Açık' : 'Kapalı';
    $('reader').classList.toggle('has-page-motion', enabled);
    $('reading-hint').textContent = enabled
      ? (state.mobile ? 'Köşeyi tutup sürükleyin; sayfaya dokunarak da çevirebilirsiniz.' : 'Köşeyi tutup sürükleyin veya sayfaya tıklayın. Ok tuşları da sayfayı çevirir.')
      : 'Sayfaları oklarla gezin. Dergi hareketi için sayfa animasyonunu açabilirsiniz.';
    if (state.book) Object.assign(state.book.getSettings(), { drawShadow: enabled, showPageCorners: enabled, flippingTime: enabled ? 1050 : 1 });
  }

  function notify(message) {
    const toast = $('toast');
    const parent = dialogs.map($).find((dialog) => dialog.open) || document.fullscreenElement || document.body;
    parent.append(toast);
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('is-visible'), 3200);
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function normalize(text) { return String(text).toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i'); }
  function hashPage() {
    const value = Number(new URLSearchParams(location.hash.slice(1)).get('sayfa'));
    return Number.isInteger(value) && value >= 1 && value <= state.catalog.pageCount ? value - 1 : 0;
  }
  function shareUrl(withPage = true) {
    const url = new URL(state.catalog?.canonicalUrl || location.href, location.href);
    url.hash = withPage ? `sayfa=${state.focus + 1}` : '';
    return url.href;
  }
  function updateHash() {
    const hash = `#sayfa=${state.focus + 1}`;
    if (location.hash !== hash) {
      try { history.replaceState(null, '', hash); }
      catch { location.hash = hash; }
    }
  }
  function visibleIndexes(index = state.index) {
    return !state.mobile && !state.plain && index > 0 ? [index, Math.min(index + 1, state.catalog.pageCount - 1)] : [index];
  }
  function hydrateNear(index = state.index) {
    if (!state.catalog) return;
    $('book-stage').querySelectorAll('img[data-page-index]').forEach((image) => {
      const i = Number(image.dataset.pageIndex);
      if (!image.getAttribute('src') && i >= index - 2 && i <= index + 4) {
        image.src = state.catalog.pages[i].image;
        image.addEventListener('error', () => {
          if (!image.dataset.retried && state.catalog.pages[i].thumb) { image.dataset.retried = 'true'; image.src = state.catalog.pages[i].thumb; }
        }, { once: true });
      }
    });
  }
  function reflectPage(index) {
    state.index = clamp(index, 0, state.catalog.pageCount - 1);
    const visible = visibleIndexes();
    if (state.requested !== null && visible.includes(state.requested)) state.focus = state.requested;
    else if (!visible.includes(state.focus)) state.focus = state.index;
    state.requested = null;
    hydrateNear();
    $('book-stage').classList.toggle('is-cover', !state.mobile && !state.plain && state.index === 0);
    $('previous').disabled = state.index === 0;
    $('next').disabled = visible[visible.length - 1] >= state.catalog.pageCount - 1;
    $('page-input').value = String(state.focus + 1);
    $('page-total').textContent = `/ ${state.catalog.pageCount}`;
    $('current-page-title').textContent = state.catalog.pages[state.focus].title;
    const announcement = `Sayfa ${visible.map((i) => i + 1).join(' ve ')}. ${state.catalog.pages[state.focus].title}`;
    if ($('page-announcement').textContent !== announcement) $('page-announcement').textContent = announcement;
    $('reading-progress').style.width = `${(visible[visible.length - 1] + 1) / state.catalog.pageCount * 100}%`;
    $('detail-open').disabled = false;
    document.querySelectorAll('[data-thumbnail-index]').forEach((button) => {
      if (Number(button.dataset.thumbnailIndex) === state.focus) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (state.plain) $('flipbook').querySelectorAll('.book-page').forEach((page, i) => { page.hidden = i !== state.focus; });
    updateHash();
  }
  function goTo(index, animate = false) {
    if (!state.catalog) return;
    index = clamp(index, 0, state.catalog.pageCount - 1);
    state.requested = index;
    state.focus = index;
    hydrateNear(index);
    if (state.plain) return reflectPage(index);
    if (!state.book) return;
    try {
      if (animate && motionEnabled()) state.book.flip(index, 'bottom');
      else state.book.turnToPage(index);
      // Turning to the already-visible spread may not emit a flip event.
      reflectPage(state.book.getCurrentPageIndex());
    } catch { state.requested = null; }
  }
  function turn(direction) {
    if (!state.catalog || (direction < 0 ? $('previous').disabled : $('next').disabled)) return;
    if (state.plain) return goTo(state.index + direction);
    state.requested = null;
    try {
      if (!motionEnabled()) direction > 0 ? state.book.turnToNextPage() : state.book.turnToPrevPage();
      else direction > 0 ? state.book.flipNext('bottom') : state.book.flipPrev('bottom');
    } catch { /* Reaching a book boundary leaves the current page visible. */ }
  }
  function pageElement(page, index) {
    const node = document.createElement('div');
    node.className = 'book-page';
    node.dataset.pageIndex = String(index);
    node.setAttribute('aria-label', `Sayfa ${page.page}: ${page.title}`);
    node.dataset.density = 'soft';
    const placeholder = document.createElement('span');
    placeholder.className = 'page-placeholder';
    placeholder.textContent = 'Betüş Art';
    placeholder.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.dataset.pageIndex = String(index);
    image.alt = `${page.title} — katalog sayfası ${page.page}`;
    image.width = page.width;
    image.height = page.height;
    image.decoding = 'async';
    image.draggable = false;
    node.append(placeholder, image);
    return node;
  }
  function createBook() {
    if (!state.catalog || state.rebuilding) return;
    state.rebuilding = true;
    const target = state.focus;
    state.mobile = mobileQuery.matches;
    const viewport = $('book-viewport');
    const height = Math.max(48, viewport.clientHeight - 14);
    const availableWidth = Math.max(80, viewport.clientWidth - (state.mobile ? 36 : 112));
    const width = Math.floor(Math.min(availableWidth / (state.mobile ? 1 : 2), height * state.catalog.aspectRatio));
    const pageHeight = Math.round(width / state.catalog.aspectRatio);
    state.plain = !window.St?.PageFlip;
    $('book-stage').style.width = `${width * (state.mobile || state.plain ? 1 : 2)}px`;
    $('book-stage').style.height = `${pageHeight}px`;
    if (state.book) {
      // Reuse the live renderer. This library version keeps its RAF loop after destroy().
      Object.assign(state.book.getSettings(), { width, height: pageHeight, minWidth: width, maxWidth: width, minHeight: pageHeight, maxHeight: pageHeight, usePortrait: state.mobile, drawShadow: motionEnabled(), showPageCorners: motionEnabled(), flippingTime: motionEnabled() ? 1050 : 1 });
      const existing = $('flipbook');
      existing.style.minWidth = `${width * (state.mobile ? 1 : 2)}px`;
      existing.style.minHeight = `${pageHeight}px`;
      existing.style.maxWidth = `${width * 2}px`;
      state.book.getUI().setOrientationStyle(state.mobile ? 'portrait' : 'landscape');
      state.book.update();
      state.book.turnToPage(target);
      state.rebuilding = false;
      state.requested = target;
      reflectPage(state.book.getCurrentPageIndex());
      reflectMotion();
      return;
    }
    observer?.disconnect();
    $('book-stage').replaceChildren();
    const host = document.createElement('div');
    host.id = 'flipbook';
    $('book-stage').append(host);
    state.catalog.pages.forEach((page, index) => host.append(pageElement(page, index)));
    if (!state.plain) {
      state.book = new window.St.PageFlip(host, { width, height: pageHeight, size: 'fixed', usePortrait: state.mobile, showCover: true, startPage: target, drawShadow: motionEnabled(), maxShadowOpacity: .46, flippingTime: motionEnabled() ? 1050 : 1, mobileScrollSupport: true, swipeDistance: 25, showPageCorners: motionEnabled(), disableFlipByClick: false });
      state.book.on('flip', (event) => { if (!state.rebuilding) reflectPage(event.data); });
      state.book.on('init', () => { if (state.book) reflectPage(state.book.getCurrentPageIndex()); });
      state.book.on('changeState', (event) => {
        $('book-stage').classList.toggle('is-turning', event.data === 'flipping' || event.data === 'user_fold');
      });
      state.book.loadFromHTML(host.querySelectorAll('.book-page'));
      // showCover forces a hard cover in this library. A magazine uses flexible paper throughout.
      for (let i = 0; i < state.book.getPageCount(); i++) state.book.getPage(i).setDensity('soft');
    } else {
      host.style.width = `${width}px`;
      host.style.height = `${pageHeight}px`;
      host.querySelectorAll('.book-page').forEach((page) => { page.style.width = `${width}px`; page.style.height = `${pageHeight}px`; });
    }
    observer = new MutationObserver(() => hydrateNear(state.index));
    observer.observe($('book-stage'), { childList: true, subtree: true });
    state.rebuilding = false;
    state.requested = target;
    reflectPage(state.book?.getCurrentPageIndex() ?? target);
    reflectMotion();
    $('reader-message').hidden = true;
  }
  function openDialog(id) {
    const dialog = $(id);
    if (dialog.open) return;
    dialog.showModal();
    if (id === 'contents-dialog') {
      renderThumbnails($('catalog-search').value);
      $('catalog-search').focus();
    }
  }
  function renderThumbnails(query = '') {
    if (!state.catalog) return;
    const needle = normalize(query.trim());
    const matches = state.catalog.pages.map((page, index) => ({ page, index })).filter(({ page }) => !needle || normalize([page.title, ...(page.terms || []), page.page, page.printedPage ?? ''].join(' ')).includes(needle));
    $('thumbnail-grid').replaceChildren();
    matches.forEach(({ page, index }) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.thumbnailIndex = String(index);
      button.setAttribute('aria-label', `Sayfa ${page.page}: ${page.title}`);
      if (index === state.focus) button.setAttribute('aria-current', 'page');
      const imageWrap = document.createElement('span');
      imageWrap.className = 'thumb-image';
      const image = document.createElement('img');
      image.src = page.thumb;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.width = 300;
      image.height = Math.round(300 / state.catalog.aspectRatio);
      imageWrap.append(image);
      const number = document.createElement('span');
      number.className = 'thumb-number';
      number.textContent = `SAYFA ${String(page.page).padStart(2, '0')}`;
      const title = document.createElement('span');
      title.className = 'thumb-title';
      title.textContent = page.title;
      button.append(imageWrap, number, title);
      button.addEventListener('click', () => { goTo(index); $('contents-dialog').close(); });
      li.append(button);
      $('thumbnail-grid').append(li);
    });
    $('search-summary').textContent = needle ? `${matches.length} sayfa bulundu.` : `${state.catalog.pageCount} sayfa · Bir sayfaya dokunarak açın.`;
  }
  function panLimits() {
    const viewport = $('detail-viewport');
    const width = Math.min(viewport.clientWidth, viewport.clientHeight * state.catalog.aspectRatio);
    return { x: Math.max(0, (width * state.scale - viewport.clientWidth) / 2), y: Math.max(0, (width / state.catalog.aspectRatio * state.scale - viewport.clientHeight) / 2) };
  }
  function applyZoom() {
    const limits = panLimits();
    state.panX = clamp(state.panX, -limits.x, limits.x);
    state.panY = clamp(state.panY, -limits.y, limits.y);
    $('detail-image').style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    $('zoom-level').textContent = `${Math.round(state.scale * 100)}%`;
    $('zoom-out').disabled = state.scale <= 1;
    $('zoom-in').disabled = state.scale >= 4;
    $('detail-viewport').classList.toggle('is-zoomed', state.scale > 1);
  }
  function setZoom(scale) { state.scale = clamp(scale, 1, 4); applyZoom(); }
  function resetZoom() { state.scale = 1; state.panX = state.panY = 0; state.pointers.clear(); state.drag = state.pinch = null; applyZoom(); }
  function updateDetail() {
    const page = state.catalog.pages[state.focus];
    $('detail-title').textContent = page.title;
    $('detail-page-number').textContent = `SAYFA ${String(page.page).padStart(2, '0')}`;
    $('detail-page-total').textContent = `${page.page} / ${state.catalog.pageCount}`;
    $('detail-image').alt = `${page.title} — sayfa ${page.page} detay görünümü`;
    $('detail-error').hidden = true;
    $('detail-image').src = page.detail || page.image;
    $('detail-previous').disabled = state.focus === 0;
    $('detail-next').disabled = state.focus === state.catalog.pageCount - 1;
    resetZoom();
  }
  async function copyLink(url) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
      else {
        const input = document.createElement('textarea');
        input.value = url;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        const parent = dialogs.map($).find((dialog) => dialog.open) || document.body;
        parent.append(input); input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('copy');
      }
      notify('Bağlantı kopyalandı.');
    } catch { notify('Bağlantıyı adres çubuğundan kopyalayabilirsiniz.'); }
  }
  function wireControls() {
    $('motion-toggle').addEventListener('click', () => {
      motionChoice = motionEnabled() ? 'reduced' : 'full';
      reflectMotion();
    });
    $('previous').addEventListener('click', () => turn(-1));
    $('next').addEventListener('click', () => turn(1));
    $('page-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const page = Number($('page-input').value);
      if (!Number.isInteger(page) || page < 1 || page > state.catalog.pageCount) { $('page-input').value = String(state.focus + 1); return; }
      goTo(page - 1);
      $('page-input').blur();
    });
    $('contents-open').addEventListener('click', () => openDialog('contents-dialog'));
    $('catalog-search').addEventListener('input', () => renderThumbnails($('catalog-search').value));
    $('detail-open').addEventListener('click', () => { openDialog('detail-dialog'); updateDetail(); });
    $('qr-open').addEventListener('click', () => {
      const code = window.qrcode(0, 'Q');
      code.addData(shareUrl(false)); code.make();
      const image = $('runtime-qr-image');
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        $('runtime-qr-download').href = canvas.toDataURL('image/png');
      };
      image.src = code.createDataURL(16, 64);
      openDialog('qr-dialog');
    });
    $('copy-catalog').addEventListener('click', () => copyLink(shareUrl(false)));
    $('share').addEventListener('click', async () => {
      const url = shareUrl();
      if (navigator.share) { try { await navigator.share({ title: 'Betüş Art — Seramik Koleksiyonu', text: `${state.catalog.pages[state.focus].title} · Sayfa ${state.focus + 1}`, url }); } catch (error) { if (error.name !== 'AbortError') await copyLink(url); } }
      else await copyLink(url);
    });
    document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
    dialogs.forEach((id) => $(id).addEventListener('click', (event) => {
      if (event.target !== $(id)) return;
      const rect = $(id).getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close();
    }));
    $('detail-dialog').addEventListener('close', () => { state.pointers.clear(); state.drag = state.pinch = null; });
    $('detail-image').addEventListener('error', () => { $('detail-error').hidden = false; });
    $('detail-previous').addEventListener('click', () => { goTo(state.focus - 1); updateDetail(); });
    $('detail-next').addEventListener('click', () => { goTo(state.focus + 1); updateDetail(); });
    $('zoom-in').addEventListener('click', () => setZoom(state.scale + .5));
    $('zoom-out').addEventListener('click', () => setZoom(state.scale - .5));
    $('zoom-reset').addEventListener('click', resetZoom);
    const detail = $('detail-viewport');
    detail.addEventListener('dblclick', () => setZoom(state.scale > 1 ? 1 : 2));
    detail.addEventListener('wheel', (event) => { event.preventDefault(); setZoom(state.scale + (event.deltaY < 0 ? .15 : -.15)); }, { passive: false });
    detail.addEventListener('pointerdown', (event) => {
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      detail.setPointerCapture(event.pointerId);
      if (state.pointers.size === 2) { const [a, b] = [...state.pointers.values()]; state.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: state.scale }; state.drag = null; }
      else state.drag = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
      detail.classList.add('is-dragging');
    });
    detail.addEventListener('pointermove', (event) => {
      if (!state.pointers.has(event.pointerId)) return;
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (state.pointers.size === 2 && state.pinch) { const [a, b] = [...state.pointers.values()]; setZoom(state.pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, state.pinch.distance)); }
      else if (state.drag && state.scale > 1) { state.panX = state.drag.panX + event.clientX - state.drag.x; state.panY = state.drag.panY + event.clientY - state.drag.y; applyZoom(); }
    });
    function pointerEnd(event) {
      state.pointers.delete(event.pointerId); state.pinch = null; state.drag = null;
      if (state.pointers.size === 1) { const point = [...state.pointers.values()][0]; state.drag = { ...point, panX: state.panX, panY: state.panY }; }
      if (!state.pointers.size) detail.classList.remove('is-dragging');
    }
    detail.addEventListener('pointerup', pointerEnd);
    detail.addEventListener('pointercancel', pointerEnd);
    if (document.fullscreenEnabled && $('reader').requestFullscreen) {
      $('fullscreen').hidden = false;
      $('fullscreen').addEventListener('click', async () => {
        try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('reader').requestFullscreen(); }
        catch { notify('Tam ekran bu tarayıcıda açılamadı.'); }
      });
      document.addEventListener('fullscreenchange', () => {
        const active = Boolean(document.fullscreenElement);
        $('fullscreen').setAttribute('aria-label', active ? 'Tam ekrandan çık' : 'Tam ekran görüntüleme');
        $('fullscreen-label').textContent = active ? 'Tam ekrandan çık' : 'Tam ekran görüntüleme';
        $('fullscreen-label-compact').textContent = active ? 'Çık' : 'Tam ekran';
      });
    }
    document.addEventListener('keydown', (event) => {
      if (!state.catalog || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (dialogs.some((id) => $(id).open)) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); turn(1); }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); turn(-1); }
      if (event.key === 'Home') { event.preventDefault(); goTo(0); }
      if (event.key === 'End') { event.preventDefault(); goTo(state.catalog.pageCount - 1); }
    });
    window.addEventListener('hashchange', () => goTo(hashPage()));
    const resize = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { createBook(); if ($('detail-dialog').open) applyZoom(); }, 120);
    });
    resize.observe($('book-viewport'));
  }
  async function initialize() {
    try {
      const catalog = window.BETUS_CATALOG;
      if (!Array.isArray(catalog.pages) || !catalog.pages.length || catalog.pages.length !== catalog.pageCount || !Number.isFinite(catalog.aspectRatio)) throw new Error('manifest');
      state.catalog = catalog;
      state.focus = hashPage();
      $('page-input').max = String(catalog.pageCount);
      $('collection-label').textContent = `${catalog.pageCount} SAYFALIK KOLEKSİYON`;
      document.querySelectorAll('[data-business]').forEach((link) => { if (catalog.links?.[link.dataset.business]) link.href = catalog.links[link.dataset.business]; });
      createBook();
      wireControls();
      ['contents-open', 'page-input', 'share', 'qr-open', 'motion-toggle'].forEach((id) => { $(id).disabled = false; });
      $('page-form').querySelector('button').disabled = false;
      if (location.protocol === 'file:') {
        // Local file paths are specific to one computer; they are not public QR targets.
        $('share').hidden = true;
        $('qr-open').hidden = true;
      }
    } catch {
      $('reader-message').classList.add('is-error');
      $('reader-message').replaceChildren();
      const message = document.createElement('p');
      message.textContent = 'Katalog şu anda açılamadı. Bağlantınızı kontrol edip yeniden deneyin.';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Yeniden dene'; retry.addEventListener('click', () => location.reload());
      $('reader-message').append(message, retry);
    }
  }
  initialize();
})();
