/**
 * Milpa Remote Runtime — milpa-live-remote.js
 *
 * The OTHER layer (ADR#9, greenhouse decisions/0083): the client half of the live wire. Where
 * milpa-live.js only activates local UX, this file takes an action a server-rendered component
 * declared (`@click="sort(key)"`, `@change="toggleRow(id)"`), sends it to the LiveEndpoint, and
 * applies what the server answers. It decides NOTHING: the server holds the truth and the signed
 * state; this runtime only echoes the envelope it was handed and paints the HTML it gets back.
 *
 * Wire (see Milpa\Live\Http\LiveEndpoint): POST {endpoint} with JSON
 *   { action, payload, state: <the last envelope the server signed>, sessionId, csrfToken }
 * and apply `html` + the new `state` from the response. The envelope is never built here — the
 * client cannot hold the signing secret — it is read from the `<script type="application/milpa+xhtml"
 * data-milpa-state="<componentId>">` the renderer embedded, and replaced with the one the server
 * returns. Boot data (endpoint, sessionId, csrfToken, optional authorization) comes from the
 * `<script id="milpa-live-boot" type="application/json">` the page embeds (Milpa\Live\Http\LiveBoot).
 *
 * Client-local persistence: a component with a `persistKey` remembers its selection/sort in
 * localStorage (or sessionStorage when `storage: 'session'`) so a reload keeps what the human chose.
 * That is UX memory, not truth: the server re-validates every action against the signed state.
 *
 * No-build (ADR#10): hand-written, readable, served as-is. Loads after milpa-live.js and before
 * alpine.min.js; all three `defer`, so they run in document order.
 *
 * (c) Rodrigo Vicente - TeamX Agency — https://teamx.agency · Apache-2.0
 */
(function () {
  'use strict';

  function bootData() {
    var el = document.getElementById('milpa-live-boot');
    if (!el) { return null; }
    try { return JSON.parse(el.textContent || '{}'); } catch (e) { return null; }
  }

  // The signed envelope is keyed by componentId and unique in the document. The renderer may place
  // it INSIDE the component root or as an adjacent sibling (the shared component layout appends it
  // after the body), so look in the root first, then fall back to the whole document.
  function envelopeScript(root, componentId) {
    return root.querySelector('script[data-milpa-state="' + componentId + '"]')
      || document.querySelector('script[data-milpa-state="' + componentId + '"]');
  }

  function envelopeOf(root, componentId) {
    var el = envelopeScript(root, componentId);
    return el ? el.textContent : null;
  }

  function storageFor(kind) {
    try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
  }

  // The default transport: a same-origin fetch to the endpoint. Returns { status, data }.
  function fetchTransport(boot, requestBody) {
    var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (boot.authorization) { headers['Authorization'] = boot.authorization; }
    return fetch(boot.endpoint, {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: JSON.stringify(requestBody),
    }).then(function (r) {
      return r.json().then(function (data) { return { status: r.status, data: data }; });
    });
  }

  // Send one declared action and hand back the parsed response. The transport is PLUGGABLE: a host
  // that cannot make a same-origin fetch — a native shell (Electron/WebView) whose page is file:// but
  // whose backend is a container, for instance — sets `window.MilpaLive.transport` to route the POST
  // through its own bridge (e.g. an IPC channel). It receives (boot, requestBody) and returns a
  // Promise<{ status, data }>. Left unset, the runtime uses a plain fetch (a normal web page).
  function send(boot, componentRoot, componentId, action, payload) {
    var envelope = envelopeOf(componentRoot, componentId);
    if (!boot || !envelope) {
      return Promise.reject(new Error('live: no boot data or no signed state on this component'));
    }
    var requestBody = {
      action: action,
      payload: payload || {},
      state: envelope,
      sessionId: boot.sessionId,
      csrfToken: boot.csrfToken,
    };
    var transport = (window.MilpaLive && typeof window.MilpaLive.transport === 'function') ? window.MilpaLive.transport : fetchTransport;
    return Promise.resolve(transport(boot, requestBody));
  }

  // Apply the server's answer: the re-rendered HTML replaces the component root (the new root
  // carries the new signed envelope and its own x-data, so Alpine mounts it fresh), or the
  // component shows the error the server returned.
  function apply(result, componentRoot, self, componentId) {
    if (result.status >= 200 && result.status < 300 && result.data && result.data.html) {
      // The server's html is the whole component render (root + its signed envelope). If the old
      // envelope was a SIBLING of the root (not inside it), drop it first so the swap doesn't leave a
      // stale duplicate keyed by the same componentId.
      var stale = componentId ? document.querySelector('script[data-milpa-state="' + componentId + '"]') : null;
      if (stale && !componentRoot.contains(stale)) { stale.remove(); }
      componentRoot.outerHTML = result.data.html;
      return;
    }
    var err = (result.data && (result.data.message || result.data.error)) || ('live: HTTP ' + result.status);
    self.error = err;
  }

  // milpaDataTable: selection, sort and paging over the wire; selection remembered locally.
  function milpaDataTable(config) {
    var cfg = config || {};
    var initial = cfg.initialState || {};
    return {
      componentId: cfg.componentId || '',
      selectedRows: Array.isArray(initial.selectedRows) ? initial.selectedRows.slice() : [],
      sortBy: initial.sortBy != null ? initial.sortBy : '',
      sortDirection: initial.sortDirection != null ? initial.sortDirection : 'asc',
      page: initial.page != null ? initial.page : 1,
      error: initial.error != null ? initial.error : null,
      busy: false,
      init: function () {
        var store = cfg.persistKey ? storageFor(cfg.storage) : null;
        if (store) {
          try {
            var saved = JSON.parse(store.getItem('milpa-live:' + cfg.persistKey) || 'null');
            if (saved && Array.isArray(saved.selectedRows)) { this.selectedRows = saved.selectedRows; }
          } catch (e) { /* a broken memory is an empty memory */ }
        }
      },
      remember: function () {
        var store = cfg.persistKey ? storageFor(cfg.storage) : null;
        if (store) {
          try { store.setItem('milpa-live:' + cfg.persistKey, JSON.stringify({ selectedRows: this.selectedRows })); } catch (e) { /* ignore */ }
        }
      },
      isSelected: function (rowId) { return this.selectedRows.indexOf(rowId) !== -1; },
      sortState: function (key) {
        if (this.sortBy !== key) { return 'none'; }
        return this.sortDirection === 'desc' ? 'descending' : 'ascending';
      },
      act: function (action, payload) {
        var self = this;
        var root = this.$root;
        this.busy = true;
        this.error = null;
        return send(bootData(), root, this.componentId, action, payload)
          .then(function (result) { apply(result, root, self, self.componentId); })
          .catch(function (e) { self.error = e.message; })
          .then(function () { self.busy = false; self.remember(); });
      },
      sort: function (key) { return this.act('sort', { key: key }); },
      setPage: function (page) { return this.act('page', { page: page }); },
      toggleRow: function (rowId) {
        // optimistic local echo, then the server's word replaces it
        var i = this.selectedRows.indexOf(rowId);
        if (i === -1) { this.selectedRows.push(rowId); } else { this.selectedRows.splice(i, 1); }
        return this.act('toggle-row', { rowId: rowId });
      },
      clearSelection: function () { this.selectedRows = []; return this.act('clear-selection', {}); },
    };
  }

  // Write the server's freshly signed envelope back into the DOM so the NEXT action echoes it. A
  // component that renders its own dynamic lists client-side (Alpine x-for) does NOT swap its
  // outerHTML — so, unlike milpaDataTable, it must refresh the envelope in place or the next action
  // would replay a stale nonce (409).
  function refreshEnvelope(root, componentId, newState) {
    if (!newState) { return; }
    var el = envelopeScript(root, componentId);
    if (el) { el.textContent = newState; }
  }

  // milpaAutocomplete: server-search over the wire. The listbox and chips are rendered client-side
  // (x-for over `items`/`selected`), so each action updates state DATA from the response and keeps the
  // input focused — it never swaps the component. The server holds the truth: it re-validates every
  // action against the signed envelope and hands back the authoritative items/selection + a new envelope.
  function milpaAutocomplete(config) {
    var cfg = config || {};
    var initial = cfg.initialState || {};
    var multiple = cfg.multiple === true;
    function keyOf(item) { return String((item && (item.value != null ? item.value : item.label)) || ''); }
    function has(list, item) { return list.some(function (c) { return keyOf(c) === keyOf(item); }); }
    function without(items, selected) { return items.filter(function (i) { return !has(selected, i); }); }

    return {
      componentId: cfg.componentId || '',
      query: initial.query || '',
      selected: Array.isArray(initial.selected) ? initial.selected.slice() : [],
      items: Array.isArray(initial.items) ? initial.items.slice() : [],
      open: false,
      loading: false,
      error: null,
      activeIndex: -1,

      submit: function (action, payload, sync) {
        var self = this;
        var root = this.$root;
        this.loading = true;
        this.error = null;
        return send(bootData(), root, this.componentId, action, payload)
          .then(function (result) {
            if (result.status >= 200 && result.status < 300 && result.data) {
              refreshEnvelope(root, self.componentId, result.data.state);
              sync(result.data.data || {});
            } else {
              self.error = (result.data && (result.data.message || result.data.error)) || ('live: HTTP ' + result.status);
            }
          })
          .catch(function (e) { self.error = e.message; })
          .then(function () { self.loading = false; });
      },

      search: function () {
        var self = this;
        this.open = true;
        return this.submit('search', { query: this.query }, function (data) {
          self.items = without(Array.isArray(data.items) ? data.items : [], self.selected);
          self.activeIndex = self.items.length ? 0 : -1;
        });
      },

      move: function (delta) {
        if (!this.items.length) { return; }
        var n = this.activeIndex + delta;
        this.activeIndex = n < 0 ? this.items.length - 1 : (n >= this.items.length ? 0 : n);
      },

      selectActive: function () {
        if (this.activeIndex >= 0 && this.items[this.activeIndex]) { this.select(this.items[this.activeIndex]); }
      },

      select: function (item) {
        var self = this;
        return this.submit('select', { item: item }, function (data) {
          if (Array.isArray(data.selected)) { self.selected = multiple ? data.selected : data.selected.slice(-1); }
          self.items = [];
          self.query = '';
          self.open = false;
        });
      },

      remove: function (item) {
        var self = this;
        return this.submit('remove', { item: item }, function (data) {
          if (Array.isArray(data.selected)) { self.selected = data.selected; }
        });
      },

      clear: function () {
        var self = this;
        return this.submit('clear', {}, function (data) {
          self.selected = Array.isArray(data.selected) ? data.selected : [];
          self.items = [];
          self.query = '';
        });
      },
    };
  }

  document.addEventListener('alpine:init', function () {
    window.Alpine.data('milpaDataTable', milpaDataTable);
    window.Alpine.data('milpaAutocomplete', milpaAutocomplete);
  });

  // Merge, never replace: keep any transport a host set and the local runtime's storage helpers.
  window.MilpaLive = Object.assign(window.MilpaLive || {}, { send: send, bootData: bootData });
}());
