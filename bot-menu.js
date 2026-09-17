(() => {
  'use strict';

  const app = document.getElementById('app');
  const tg = window.Telegram?.WebApp;
  const demo = app.dataset.demo !== 'false';
  const apiBase = app.dataset.apiBase.replace(/\/$/, '');
  const threadContextToken = new URLSearchParams(window.location.search).get('thread_context') || '';
  const pollIntervalMs = 2000;

  const ui = {
    controls: document.getElementById('controls'),
    menuToggle: document.querySelector('.menu-toggle'),
    status: document.querySelector('.status'),
    title: document.getElementById('status-title'),
    detail: document.getElementById('status-detail'),
    percent: document.getElementById('status-percent'),
    progress: document.querySelector('.progress'),
    progressBar: document.getElementById('progress-bar'),
    details: document.getElementById('details'),
    domain: document.getElementById('current-domain'),
    sheet: document.getElementById('current-sheet'),
    processed: document.getElementById('processed-sites'),
    remaining: document.getElementById('remaining-sites'),
    hint: document.getElementById('hint'),
    start: document.querySelector('[data-action="start"]'),
    view: document.querySelector('[data-action="view"]'),
    stop: document.querySelector('[data-action="stop"]'),
    cancel: document.querySelector('[data-action="cancel"]')
  };

  let currentJob = null;
  let pollTimer = null;
  let demoTimer = null;
  let pollSeq = 0;

  const labels = {
    idle: ['Готово до запуску', 'Оновлення не виконується'],
    queued: ['Оновлення в черзі', 'Очікування запуску'],
    running: ['Оновлення виконується', 'Завантаження стану…'],
    completed: ['Оновлення завершено', 'Доступний відкат'],
    stopped: ['Оновлення зупинено', 'Залишок черги збережено'],
    failed: ['Помилка оновлення', 'Перегляньте журнал'],
    rollback_pending: ['Виконується відкат', 'Відновлення попередніх даних'],
    rolled_back: ['Оновлення скасовано', 'Попередні дані відновлено'],
    rollback_failed: ['Помилка відкату', 'Потрібне втручання розробника']
  };

  function iconFor(status) {
    if (['queued', 'running', 'rollback_pending'].includes(status)) return '#i-loader';
    if (['completed', 'rolled_back'].includes(status)) return '#i-check';
    if (['stopped', 'failed', 'rollback_failed'].includes(status)) return '#i-x';
    return '#i-info';
  }

  function normalizeJob(job = {}) {
    const total = Number(job.total_sites || 0);
    const processed = Number(job.processed_sites || 0);
    return {
      job_id: job.job_id || null,
      status: job.status || 'idle',
      total_sites: total,
      processed_sites: processed,
      remaining_sites: Number(job.remaining_sites ?? Math.max(0, total - processed)),
      current_domain: job.current_domain || '—',
      current_sheet: job.current_sheet || '—',
      rollback_available: Boolean(job.rollback_available),
      error_count: Number(job.error_count || 0),
      last_error: job.last_error || null
    };
  }

  function render(rawJob) {
    currentJob = normalizeJob(rawJob);
    const status = currentJob.status;
    const isBusy = ['queued', 'running', 'rollback_pending'].includes(status);
    const isRunning = ['queued', 'running'].includes(status);
    const progress = currentJob.total_sites
      ? Math.round((currentJob.processed_sites / currentJob.total_sites) * 100)
      : 0;
    const copy = labels[status] || labels.idle;

    app.classList.toggle('is-running', isRunning);
    ui.status.className = `status status--${status}`;
    ui.status.querySelector('use').setAttribute('href', iconFor(status));
    ui.status.querySelector('use').setAttribute('xlink:href', iconFor(status));
    ui.title.textContent = copy[0];
    ui.detail.textContent = currentJob.last_error || (status === 'running' && currentJob.current_domain !== '—'
      ? `Зараз: ${currentJob.current_domain}`
      : copy[1]);
    ui.percent.textContent = isBusy || status === 'completed' ? `${progress}%` : '';
    ui.progress.classList.toggle('is-visible', isBusy || status === 'completed');
    ui.progressBar.style.width = `${progress}%`;
    ui.progress.setAttribute('aria-valuenow', String(progress));

    ui.start.disabled = isBusy;
    ui.view.disabled = false;
    ui.stop.disabled = !isRunning;
    ui.cancel.disabled = status !== 'completed' || !currentJob.rollback_available;

    ui.domain.textContent = currentJob.current_domain;
    ui.sheet.textContent = currentJob.current_sheet;
    ui.processed.textContent = `${currentJob.processed_sites} / ${currentJob.total_sites}`;
    ui.remaining.textContent = String(currentJob.remaining_sites);
    ui.hint.textContent = status === 'completed' && currentJob.rollback_available
      ? 'Оновлення завершено — відкат доступний.'
      : isRunning
        ? 'Можна переглянути чергу або зупинити процес.'
        : '«Скасувати» стане доступною після повного оновлення.';
  }

  async function request(path, options = {}, retries = 2) {
    for (let attempt = 0; ; attempt++) {
      try {
        // GET polls always hit the exact same URL (e.g. /bot/jobs/current) -
        // without a cache-buster the browser/WebView is free to serve a
        // stale cached response instead of asking the server again, which
        // looked like the UI "not updating in real time".
        const sep = path.includes('?') ? '&' : '?';
        const url = `${apiBase}${path}${sep}_=${Date.now()}`;
        const response = await fetch(url, {
          ...options,
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Init-Data': tg?.initData || '',
            'X-Bot-Thread-Context': threadContextToken,
            ...options.headers
          }
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok === false) throw new Error(body.message || `HTTP ${response.status}`);
        // ok:true with no job data means something upstream returned a
        // malformed/empty success response (seen during n8n host hiccups) -
        // treat it as an error rather than handing undefined to the caller,
        // which crashed with "Cannot read properties of undefined".
        if (!body.job) throw new Error('Malformed response: missing job data');
        return body.job;
      } catch (error) {
        // "Failed to fetch" (TypeError) means the request never reached/returned from
        // the server at all — server may still be slow/flaky (n8n host), not a real
        // rejection like 401/409. Retry those with backoff instead of surfacing them.
        const isNetworkError = error instanceof TypeError;
        if (isNetworkError && attempt < retries) {
          await new Promise(resolve => window.setTimeout(resolve, 1500 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  }

  function beginPolling() {
    window.clearInterval(pollTimer);
    pollTimer = window.setInterval(loadCurrent, pollIntervalMs);
  }

  async function loadCurrent() {
    if (demo) return;
    // Retries add variable delay, so two overlapping polls can resolve out
    // of order — a slow earlier response arriving after a faster later one
    // would repaint the UI with stale data (the "flickers back to an old
    // status" symptom). Only the most recently STARTED call is allowed to
    // touch the DOM; anything that resolves after a newer call already
    // started is silently discarded.
    const mySeq = ++pollSeq;
    try {
      const job = await request('/bot/jobs/current');
      if (mySeq !== pollSeq) return;
      render(job);
      // Keep polling alive whenever the job is active, regardless of HOW this
      // check was triggered (fresh page load reopening an already-running
      // job, not just the "Start" click) — otherwise a reopened Mini App
      // shows one static snapshot forever until manually refreshed.
      if (['queued', 'running', 'rollback_pending'].includes(job.status)) {
        beginPolling();
      } else {
        window.clearInterval(pollTimer);
      }
    } catch (error) {
      if (mySeq !== pollSeq) return;
      ui.hint.textContent = error.message;
    }
  }

  function runDemo() {
    window.clearInterval(demoTimer);
    let processed = 0;
    const total = 12;
    render({ job_id: 'demo-job', status: 'running', total_sites: total, processed_sites: 0, current_domain: 'first-site.example', current_sheet: 'Offers UK' });
    demoTimer = window.setInterval(() => {
      processed += 1;
      const done = processed >= total;
      render({
        job_id: 'demo-job',
        status: done ? 'completed' : 'running',
        total_sites: total,
        processed_sites: processed,
        remaining_sites: total - processed,
        current_domain: done ? '—' : `site-${processed + 1}.example`,
        current_sheet: done ? '—' : 'Offers UK',
        rollback_available: done
      });
      if (done) window.clearInterval(demoTimer);
    }, 650);
  }

  async function start() {
    ui.start.disabled = true;
    if (demo) return runDemo();
    const mySeq = ++pollSeq;
    try {
      const idempotencyKey = crypto.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const job = await request('/bot/jobs/start', {
        method: 'POST',
        body: JSON.stringify({ idempotency_key: idempotencyKey })
      });
      if (mySeq !== pollSeq) return;
      render(job);
      beginPolling();
    } catch (error) {
      // The POST may have actually reached the server and created the job
      // even though this browser never got a clean response back (slow/
      // flaky host) — check current state once before declaring failure.
      // Only trust it as evidence THIS start succeeded if the job is
      // actively in progress: an 'idle'/'completed'/'failed' job here is
      // just the PREVIOUS run's leftover state, not proof this click did
      // anything — showing it as success would misreport a real failure.
      try {
        const job = await request('/bot/jobs/current');
        if (mySeq !== pollSeq) return;
        if (job && job.job_id && ['queued', 'running', 'rollback_pending'].includes(job.status)) {
          render(job);
          beginPolling();
          return;
        }
      } catch (_) {
        // fall through to failed state below
      }
      if (mySeq !== pollSeq) return;
      render({ status: 'failed', last_error: error.message });
    }
  }

  async function stop() {
    if (!currentJob?.job_id) return;
    ui.stop.disabled = true;
    if (demo) {
      window.clearInterval(demoTimer);
      return render({ ...currentJob, status: 'stopped' });
    }
    const mySeq = ++pollSeq;
    try {
      const job = await request(`/bot/jobs/${encodeURIComponent(currentJob.job_id)}/stop`, { method: 'POST', body: '{}' });
      if (mySeq !== pollSeq) return;
      render(job);
    } catch (error) {
      if (mySeq !== pollSeq) return;
      ui.hint.textContent = error.message;
      ui.stop.disabled = false;
    }
  }

  async function rollback() {
    if (!currentJob?.job_id) return;
    ui.cancel.disabled = true;
    if (demo) {
      render({ ...currentJob, status: 'rollback_pending', rollback_available: false });
      return window.setTimeout(() => render({ ...currentJob, status: 'rolled_back', rollback_available: false }), 1200);
    }
    const mySeq = ++pollSeq;
    try {
      const job = await request(`/bot/jobs/${encodeURIComponent(currentJob.job_id)}/rollback`, { method: 'POST', body: '{}' });
      if (mySeq !== pollSeq) return;
      render(job);
      beginPolling();
    } catch (error) {
      if (mySeq !== pollSeq) return;
      ui.hint.textContent = error.message;
      ui.cancel.disabled = false;
    }
  }

  ui.menuToggle.addEventListener('click', () => {
    const willClose = !ui.controls.hidden;
    ui.controls.hidden = willClose;
    ui.menuToggle.setAttribute('aria-expanded', String(!willClose));
    ui.menuToggle.querySelector('use').setAttribute('href', willClose ? '#i-menu' : '#i-x');
  });
  ui.start.addEventListener('click', start);
  ui.view.addEventListener('click', () => { ui.details.hidden = !ui.details.hidden; if (!demo) loadCurrent(); });
  ui.stop.addEventListener('click', stop);
  ui.cancel.addEventListener('click', rollback);

  tg?.ready();
  tg?.expand();
  render({ status: 'idle' });
  loadCurrent();
})();
