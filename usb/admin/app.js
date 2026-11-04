'use strict';
/* Admin panel front end. Plain DOM, no build step, no dependencies —
   it has to run off a USB stick with no network access. */

(function () {
  // ---- tiny helpers -----------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    csrf: null,
    username: null,
    config: null,
    tree: null,
    status: null,
    openPath: null,
    openContent: '',
    dirty: false,
  };

  let toastTimer = null;
  function toast(message, bad = false) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('bad', !!bad);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 3000);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // All requests are relative to the panel's own directory, so the admin
  // path can be renamed in settings without touching this file.
  async function api(pathname, options = {}) {
    const opts = { credentials: 'same-origin', headers: {}, ...options };
    if (state.csrf && !['GET', 'HEAD'].includes((opts.method || 'GET').toUpperCase())) {
      opts.headers['X-CSRF-Token'] = state.csrf;
    }
    if (opts.json !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }

    let res;
    try {
      res = await fetch(pathname, opts);
    } catch {
      throw new Error('Cannot reach the server. Is it still running?');
    }

    if (res.status === 401) {
      showLogin('Your session expired. Please sign in again.');
      throw new Error('not signed in');
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (!res.ok) throw new Error(`Server error (HTTP ${res.status})`);
      return res;
    }

    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---- views ------------------------------------------------------------

  function showLogin(message) {
    state.csrf = null;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    const err = $('#login-error');
    if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
    $('#login-username').focus();
  }

  function showApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
  }

  const VIEWS = ['dashboard', 'files', 'settings', 'logs'];

  function switchView(name) {
    if (!VIEWS.includes(name)) name = 'dashboard';
    for (const view of VIEWS) {
      $(`#view-${view}`).hidden = view !== name;
    }
    for (const tab of $$('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === name));
    }
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);

    if (name === 'dashboard') loadDashboard();
    if (name === 'files') loadTree();
    if (name === 'settings') loadConfig();
    if (name === 'logs') loadLogs();
  }

  // ---- dashboard --------------------------------------------------------

  function statCard(label, value, sub) {
    return `<div class="stat">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}
    </div>`;
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m ${seconds % 60}s`;
  }

  async function loadDashboard() {
    let s;
    try {
      s = await api('api/status');
    } catch (err) {
      toast(err.message, true);
      return;
    }
    state.status = s;

    $('#status-grid').innerHTML = [
      statCard('Uptime', formatUptime(s.uptimeSeconds), `since ${new Date(s.startedAt).toLocaleString()}`),
      statCard('Requests served', String(s.requests), `${s.bytesServedHuman} sent`),
      statCard('Site content', `${s.site.files} files`, s.site.human),
      statCard('Errors', String(s.errors), s.errors ? 'check the error log' : 'none logged'),
      s.disk ? statCard('Free space', s.disk.free, `of ${s.disk.total}`) : '',
      statCard('Host', s.host.hostname, `${s.host.platform} · Node ${s.host.node}`),
    ].join('');

    // "View site" must point at the public port, which differs from the
    // panel's port when a separate admin port is configured.
    const siteUrl = `${location.protocol}//${location.hostname}:${s.server.port}/`;
    $('#visit-site').href = siteUrl;

    const lan = s.host.lanAddresses.map((a) => `http://${a.address}:${s.server.port}/`);
    $('#reach-info').innerHTML = `
      <dl class="kv"><dt>On this network</dt><dd>${lan.length ? lan.map(escapeHtml).join('<br>') : 'no LAN address detected'}</dd></dl>
      <dl class="kv"><dt>Public address</dt><dd>${s.ddns.lastIp ? escapeHtml(s.ddns.lastIp) : 'unknown — enable dynamic DNS to detect it'}</dd></dl>
      <dl class="kv"><dt>Router forwarding</dt><dd>external 80 &rarr; ${escapeHtml(lan[0] ? new URL(lan[0]).hostname : 'this machine')}:${s.server.port}</dd></dl>
      <p class="muted small">Your Telstra modem must forward an external port to this machine's LAN address and port
      for the site to be reachable from outside. See <code>docs/02-telstra-router-setup.md</code>.</p>`;

    const d = s.ddns;
    $('#ddns-info').innerHTML = `
      <dl class="kv"><dt>Status</dt><dd>${d.enabled
        ? `<span class="pill pill-ok">enabled</span> ${escapeHtml(d.provider)}, every ${d.intervalMinutes} min`
        : '<span class="pill">disabled</span>'}</dd></dl>
      <dl class="kv"><dt>Current address</dt><dd>${escapeHtml(d.lastIp || '—')}</dd></dl>
      <dl class="kv"><dt>Last run</dt><dd>${d.lastRunAt ? escapeHtml(new Date(d.lastRunAt).toLocaleString()) : 'never'}</dd></dl>
      <dl class="kv"><dt>Result</dt><dd>${d.lastError
        ? `<span class="pill pill-bad">error</span> ${escapeHtml(d.lastError)}`
        : escapeHtml(d.lastResult || '—')}</dd></dl>`;

    const problems = s.problems || [];
    $('#problems-card').hidden = problems.length === 0;
    $('#problems-list').innerHTML = problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  }

  // ---- file tree --------------------------------------------------------

  const collapsed = new Set();

  function renderNodes(entries) {
    if (!entries.length) return '<p class="muted small">This folder is empty.</p>';
    const render = (list) => '<ul>' + list.map((entry) => {
      if (entry.type === 'dir') {
        const isOpen = !collapsed.has(entry.path);
        return `<li>
          <div class="node" data-type="dir" data-path="${escapeHtml(entry.path)}">
            <span class="twisty">${isOpen ? '▾' : '▸'}</span>
            <span class="node-name">${escapeHtml(entry.name)}</span>
            <span class="node-actions">
              <button type="button" data-act="rename" title="Rename">✎</button>
              <button type="button" data-act="delete" title="Delete">✕</button>
            </span>
          </div>
          ${isOpen ? render(entry.children) : ''}
        </li>`;
      }
      const current = entry.path === state.openPath;
      return `<li>
        <div class="node" data-type="file" data-path="${escapeHtml(entry.path)}"
             data-editable="${entry.editable}" ${current ? 'aria-current="true"' : ''}>
          <span class="twisty"></span>
          <span class="node-name">${escapeHtml(entry.name)}</span>
          <span class="node-size">${escapeHtml(entry.sizeHuman)}</span>
          <span class="node-actions">
            <button type="button" data-act="download" title="Download">⭳</button>
            <button type="button" data-act="rename" title="Rename">✎</button>
            <button type="button" data-act="delete" title="Delete">✕</button>
          </span>
        </div>
      </li>`;
    }).join('') + '</ul>';
    return render(entries);
  }

  async function loadTree() {
    let data;
    try {
      data = await api('api/tree');
    } catch (err) {
      toast(err.message, true);
      return;
    }
    state.tree = data;
    $('#tree').innerHTML = renderNodes(data.entries);
    $('#tree-summary').textContent =
      `${data.fileCount} file${data.fileCount === 1 ? '' : 's'}` +
      (data.truncated ? ' (listing truncated)' : '');
  }

  async function openFile(path, editable) {
    if (!editable) {
      toast('That file type opens in the editor only for text formats. Use ⭳ to download it.');
      return;
    }
    if (state.dirty && !confirm('Discard unsaved changes?')) return;

    try {
      const data = await api('api/file?path=' + encodeURIComponent(path));
      state.openPath = data.path;
      state.openContent = data.content;
      setDirty(false);

      const editor = $('#editor');
      editor.value = data.content;
      editor.disabled = false;
      $('#editor-empty').hidden = true;
      $('#editor-path').textContent = data.path;
      $('#editor-save').disabled = true;

      // Offer a preview link for anything the browser can render directly.
      const previewable = /\.(html?|css|js|json|svg|txt|md)$/i.test(data.path);
      const preview = $('#editor-preview');
      preview.hidden = !previewable;
      if (previewable && state.status) {
        const base = `${location.protocol}//${location.hostname}:${state.status.server.port}/`;
        preview.onclick = () => window.open(base + data.path.replace(/index\.html$/, ''), '_blank', 'noopener');
      }
      loadTree();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function setDirty(value) {
    state.dirty = value;
    $('#editor-dirty').hidden = !value;
    $('#editor-save').disabled = !value;
  }

  async function saveFile() {
    if (!state.openPath) return;
    const content = $('#editor').value;
    try {
      await api('api/file?path=' + encodeURIComponent(state.openPath), { method: 'PUT', json: { content } });
      state.openContent = content;
      setDirty(false);
      toast('Saved ' + state.openPath);
      loadTree();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function uploadFiles(fileList, targetDir) {
    const files = Array.from(fileList);
    if (!files.length) return;
    let done = 0;
    for (const file of files) {
      const target = (targetDir ? targetDir + '/' : '') + file.name;
      try {
        await api('api/upload?path=' + encodeURIComponent(target), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        done++;
      } catch (err) {
        toast(`${file.name}: ${err.message}`, true);
      }
    }
    if (done) toast(`Uploaded ${done} file${done === 1 ? '' : 's'}`);
    loadTree();
  }

  // Directory of the node currently selected, used as the upload target.
  function currentDir() {
    const selected = $('.node[aria-current="true"]');
    if (!selected) return '';
    const path = selected.dataset.path;
    if (selected.dataset.type === 'dir') return path;
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash);
  }

  // ---- settings ---------------------------------------------------------

  function getPath(obj, dotted) {
    return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
  }

  function setPath(obj, dotted, value) {
    const keys = dotted.split('.');
    const last = keys.pop();
    let node = obj;
    for (const key of keys) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
      node = node[key];
    }
    node[last] = value;
  }

  function fillSettings(config) {
    for (const input of $$('#settings-form [name]')) {
      const value = getPath(config, input.name);
      if (input.type === 'checkbox') input.checked = !!value;
      else input.value = value === null || value === undefined ? '' : String(value);
    }
    syncProviderVisibility();
  }

  function collectSettings() {
    const patch = {};
    for (const input of $$('#settings-form [name]')) {
      let value;
      if (input.type === 'checkbox') {
        value = input.checked;
      } else if (input.type === 'number') {
        // An empty adminPort means "share the website port".
        value = input.value === '' ? null : Number(input.value);
        if (value !== null && !Number.isFinite(value)) continue;
      } else {
        value = input.value;
      }
      setPath(patch, input.name, value);
    }
    return patch;
  }

  function syncProviderVisibility() {
    const provider = $('#settings-form [name="ddns.provider"]').value;
    for (const fieldset of $$('.subform[data-provider]')) {
      fieldset.hidden = fieldset.dataset.provider !== provider;
    }
  }

  async function loadConfig() {
    try {
      const data = await api('api/config');
      state.config = data.config;
      fillSettings(data.config);
      $('#settings-msg').hidden = true;
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---- logs -------------------------------------------------------------

  async function loadLogs() {
    const which = $('#log-which').value;
    const lines = $('#log-lines').value;
    const output = $('#log-output');
    output.textContent = 'Loading…';
    try {
      const data = await api(`api/logs?which=${encodeURIComponent(which)}&lines=${encodeURIComponent(lines)}`);
      output.textContent = data.lines.length ? data.lines.join('\n') : '(the log is empty)';
      output.scrollTop = output.scrollHeight;
    } catch (err) {
      output.textContent = 'Could not read the log: ' + err.message;
    }
  }

  // ---- wiring -----------------------------------------------------------

  function wire() {
    // Sign in
    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('#login-form button[type="submit"]');
      button.disabled = true;
      try {
        const data = await api('api/login', {
          method: 'POST',
          json: { username: $('#login-username').value, password: $('#login-password').value },
        });
        state.csrf = data.csrf;
        state.username = data.username;
        $('#login-password').value = '';
        $('#login-error').hidden = true;
        enterApp(data.mustChangePassword);
      } catch (err) {
        const el = $('#login-error');
        el.textContent = err.message;
        el.hidden = false;
      } finally {
        button.disabled = false;
      }
    });

    $('#logout').addEventListener('click', async () => {
      try { await api('api/logout', { method: 'POST' }); } catch { /* signing out locally regardless */ }
      showLogin('Signed out.');
    });

    for (const tab of $$('.tab')) {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    }
    $('#menu-toggle').addEventListener('click', () => {
      const tabs = $('#tabs');
      tabs.dataset.collapsed = tabs.dataset.collapsed === 'true' ? 'false' : 'true';
    });
    $('#goto-password').addEventListener('click', () => {
      switchView('settings');
      $('#password-form').scrollIntoView({ behavior: 'smooth' });
    });

    $('#ddns-update').addEventListener('click', async (event) => {
      event.target.disabled = true;
      try {
        const data = await api('api/ddns', { method: 'POST', json: {} });
        toast(data.message || 'DNS updated');
      } catch (err) {
        toast(err.message, true);
      } finally {
        event.target.disabled = false;
        loadDashboard();
      }
    });

    // Files
    $('#refresh-tree').addEventListener('click', loadTree);

    $('#tree').addEventListener('click', async (event) => {
      const actionButton = event.target.closest('[data-act]');
      const node = event.target.closest('.node');
      if (!node) return;
      const path = node.dataset.path;

      if (actionButton) {
        event.stopPropagation();
        const act = actionButton.dataset.act;
        if (act === 'download') {
          window.open('api/download?path=' + encodeURIComponent(path), '_blank', 'noopener');
        } else if (act === 'rename') {
          const next = prompt('New path (relative to the site folder):', path);
          if (!next || next === path) return;
          try {
            await api('api/rename', { method: 'POST', json: { from: path, to: next } });
            if (state.openPath === path) { state.openPath = next; $('#editor-path').textContent = next; }
            toast('Renamed');
            loadTree();
          } catch (err) { toast(err.message, true); }
        } else if (act === 'delete') {
          const isDir = node.dataset.type === 'dir';
          if (!confirm(`Delete ${isDir ? 'folder' : 'file'} "${path}"${isDir ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
          try {
            await api('api/delete', { method: 'POST', json: { path, recursive: isDir } });
            if (state.openPath === path) closeEditor();
            toast('Deleted ' + path);
            loadTree();
          } catch (err) { toast(err.message, true); }
        }
        return;
      }

      if (node.dataset.type === 'dir') {
        if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
        // Keep the folder highlighted so uploads land inside it.
        for (const other of $$('.node[aria-current="true"]')) other.removeAttribute('aria-current');
        node.setAttribute('aria-current', 'true');
        const wasSelected = path;
        await loadTree();
        const again = $(`.node[data-path="${CSS.escape(wasSelected)}"]`);
        if (again) again.setAttribute('aria-current', 'true');
        return;
      }

      openFile(path, node.dataset.editable === 'true');
    });

    $('#editor').addEventListener('input', () => {
      setDirty($('#editor').value !== state.openContent);
    });
    $('#editor-save').addEventListener('click', saveFile);

    // Ctrl/Cmd+S saves, the shortcut everyone reaches for reflexively.
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (!$('#view-files').hidden && state.openPath) {
          event.preventDefault();
          saveFile();
        }
      }
    });

    window.addEventListener('beforeunload', (event) => {
      if (state.dirty) { event.preventDefault(); event.returnValue = ''; }
    });

    $('#new-file').addEventListener('click', async () => {
      const dir = currentDir();
      const name = prompt('New file path (relative to the site folder):', (dir ? dir + '/' : '') + 'new-page.html');
      if (!name) return;
      try {
        await api('api/file?path=' + encodeURIComponent(name), {
          method: 'PUT',
          json: { content: name.endsWith('.html') ? starterHtml(name) : '' },
        });
        toast('Created ' + name);
        await loadTree();
        openFile(name, true);
      } catch (err) { toast(err.message, true); }
    });

    $('#new-folder').addEventListener('click', async () => {
      const dir = currentDir();
      const name = prompt('New folder path (relative to the site folder):', (dir ? dir + '/' : '') + 'new-folder');
      if (!name) return;
      try {
        await api('api/mkdir', { method: 'POST', json: { path: name } });
        toast('Created ' + name);
        loadTree();
      } catch (err) { toast(err.message, true); }
    });

    $('#upload-btn').addEventListener('click', () => $('#upload-input').click());
    $('#upload-input').addEventListener('change', (event) => {
      uploadFiles(event.target.files, currentDir());
      event.target.value = '';
    });

    // Drag and drop onto the file pane
    const pane = $('.filepane');
    for (const type of ['dragenter', 'dragover']) {
      pane.addEventListener(type, (event) => {
        event.preventDefault();
        pane.classList.add('dropzone');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      pane.addEventListener(type, (event) => {
        event.preventDefault();
        if (type === 'dragleave' && pane.contains(event.relatedTarget)) return;
        pane.classList.remove('dropzone');
      });
    }
    pane.addEventListener('drop', (event) => {
      if (event.dataTransfer && event.dataTransfer.files.length) {
        uploadFiles(event.dataTransfer.files, currentDir());
      }
    });

    // Settings
    $('#settings-form [name="ddns.provider"]').addEventListener('change', syncProviderVisibility);
    $('#settings-reload').addEventListener('click', loadConfig);
    $('#settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const msg = $('#settings-msg');
      try {
        const data = await api('api/config', { method: 'PUT', json: collectSettings() });
        state.config = data.config;
        fillSettings(data.config);
        msg.className = 'alert alert-ok';
        msg.textContent = data.restartRequired
          ? 'Saved. The port changed — restart the server for it to take effect.'
          : 'Saved.';
        msg.hidden = false;
        toast('Settings saved');
      } catch (err) {
        msg.className = 'alert alert-error';
        msg.textContent = err.message;
        msg.hidden = false;
      }
    });

    $('#password-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const msg = $('#password-msg');
      const next = form.next.value;
      if (next !== form.confirm.value) {
        msg.className = 'alert alert-error';
        msg.textContent = 'The two new passwords do not match.';
        msg.hidden = false;
        return;
      }
      try {
        await api('api/password', { method: 'POST', json: { current: form.current.value, next } });
        form.reset();
        toast('Password changed — signing you out');
        setTimeout(() => showLogin('Password changed. Sign in with the new one.'), 1200);
      } catch (err) {
        msg.className = 'alert alert-error';
        msg.textContent = err.message;
        msg.hidden = false;
      }
    });

    // Logs
    $('#log-refresh').addEventListener('click', loadLogs);
    $('#log-which').addEventListener('change', loadLogs);
    $('#log-lines').addEventListener('change', loadLogs);

    window.addEventListener('hashchange', () => switchView(location.hash.slice(1)));
  }

  function closeEditor() {
    state.openPath = null;
    state.openContent = '';
    setDirty(false);
    const editor = $('#editor');
    editor.value = '';
    editor.disabled = true;
    $('#editor-empty').hidden = false;
    $('#editor-path').textContent = 'No file open';
    $('#editor-preview').hidden = true;
  }

  function starterHtml(name) {
    const title = name.split('/').pop().replace(/\.html?$/i, '').replace(/[-_]/g, ' ');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>Write your page here.</p>
  </main>
</body>
</html>
`;
  }

  function enterApp(mustChangePassword) {
    showApp();
    $('#who').textContent = state.username ? `signed in as ${state.username}` : '';
    $('#must-change').hidden = !mustChangePassword;
    switchView(location.hash.slice(1) || 'dashboard');
  }

  async function bootstrap() {
    wire();
    try {
      const session = await api('api/session');
      if (session.signedIn) {
        state.csrf = session.csrf;
        state.username = session.username;
        enterApp(session.mustChangePassword);
        return;
      }
    } catch {
      // Fall through to the login form; the error is already surfaced there.
    }
    showLogin();
  }

  bootstrap();
})();
