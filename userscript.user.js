// ==UserScript==
// @name         Suno Console Bridge (开源本地版)
// @namespace    https://github.com/local/suno-console-bridge
// @version      1.0.0
// @description  开源本地版 Suno 登录同步与音频直传桥接助手，100% 本地闭环，无第三方中转
// @match        https://suno.com/*
// @match        https://www.suno.com/*
// @match        http://127.0.0.1:3000/*
// @match        http://localhost:3000/*
// @run-at       document-start
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      studio-api-prod.suno.com
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const AUTO_REFRESH_INTERVAL = 15_000;
  const AUTH_KEY = 'sunoConsoleAuthSync:payload';
  const HEARTBEAT_KEY = 'sunoConsoleAuthSync:heartbeat';
  const SYNC_REQUEST_KEY = 'sunoConsoleAuthSync:request';
  const COVER_VERIFICATION_REQUEST_KEY = 'sunoConsoleCoverVerification:request';
  const COVER_VERIFICATION_RESPONSE_KEY = 'sunoConsoleCoverVerification:response';

  function sessionClaims(authorization) {
    try {
      const token = String(authorization || '').replace(/^Bearer\s+/i, '');
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
      if (!Number.isFinite(claims?.exp) || claims['suno.com/claims/visitor'] === true) return null;
      if (!claims.sub && !claims['suno.com/claims/user_id']) return null;
      return claims;
    } catch { return null; }
  }

  function usableAuthorization(authorization, marginSeconds = 5) {
    const claims = sessionClaims(authorization);
    return Boolean(claims && claims.exp * 1000 > Date.now() + marginSeconds * 1000);
  }

  function cookieAuthorization(cookie) {
    const candidates = [];
    for (const part of String(cookie || '').split(';')) {
      const separator = part.indexOf('=');
      if (part.slice(0, separator).trim() !== '__session') continue;
      try {
        const authorization = `Bearer ${decodeURIComponent(part.slice(separator + 1))}`;
        const claims = sessionClaims(authorization);
        if (claims && usableAuthorization(authorization)) candidates.push({ authorization, claims });
      } catch { }
    }
    candidates.sort((a, b) => (b.claims.iat ?? b.claims.exp) - (a.claims.iat ?? a.claims.exp) || b.claims.exp - a.claims.exp);
    return candidates[0]?.authorization || null;
  }

  const isSuno = location.hostname === 'suno.com' || location.hostname === 'www.suno.com';
  if (isSuno) startSunoSync();
  else startConsoleSync();

  // -------------------------------------------------------------
  // 本地控制台端（localhost:3000）
  // -------------------------------------------------------------
  function startConsoleSync() {
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    pageWindow.__SUNO_CONSOLE_BRIDGE__ = {
      version: VERSION,
      type: 'auth-sync-upload',
      upload: true,
      localSunoRead: true
    };

    let syncing = false;
    let queuedSync = null;
    let authInvalidated = false;
    const pendingCoverVerifications = new Map();
    const pendingUploadRequests = new Map();

    async function refreshAccount() {
      try {
        const session = await fetch('/api/session', { credentials: 'include', cache: 'no-store' }).then((r) => r.json());
        return session?.user?.id || null;
      } catch {
        return null;
      }
    }

    async function sync(payload) {
      if (!payload?.headers || !usableAuthorization(payload.headers.authorization)) return;
      if (syncing) { queuedSync = payload; return; }
      syncing = true;
      try {
        const response = await fetch('/api/auth', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ headers: payload.headers })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || '同步失败');
        authInvalidated = false;
        window.dispatchEvent(new CustomEvent('suno-auth-synced', { detail: data.auth }));
      } catch (error) {
        console.error('[SunoBridge] 同步凭证至本地后端失败:', error);
      } finally {
        syncing = false;
        const next = queuedSync;
        queuedSync = null;
        if (next) void sync(next);
      }
    }

    function requestSync() {
      GM_setValue(SYNC_REQUEST_KEY, { at: Date.now() });
    }

    // 监听本地 WebUI 派发的直传 API 请求
    function handleUploadRequest(request) {
      if (!request.requestId || !request.path) return;
      if (pendingUploadRequests.has(request.requestId)) return;
      let requestBody = request.body;
      if (typeof request.bodyJson === 'string') {
        try { requestBody = JSON.parse(request.bodyJson); }
        catch {
          window.dispatchEvent(new CustomEvent('suno-console-upload-response', { detail: { requestId: request.requestId, ok: false, error: '上传请求数据无效' } }));
          return;
        }
      }
      const pending = callSunoApi(request.path, request.method, requestBody);
      pendingUploadRequests.set(request.requestId, pending);
      void pending.promise
        .then((result) => window.dispatchEvent(new CustomEvent('suno-console-upload-response', { detail: { requestId: request.requestId, ok: true, result } })))
        .catch((error) => window.dispatchEvent(new CustomEvent('suno-console-upload-response', { detail: { requestId: request.requestId, ok: false, error: error.message || String(error), status: error.status } })))
        .finally(() => pendingUploadRequests.delete(request.requestId));
    }

    window.addEventListener('suno-auth-sync-request', requestSync);
    window.addEventListener('suno-console-upload-request', (event) => handleUploadRequest(event.detail || {}));
    window.addEventListener('suno-console-upload-cancel', (event) => {
      const requestId = event.detail?.requestId;
      if (requestId) pendingUploadRequests.get(requestId)?.abort();
    });

    window.addEventListener('suno-cover-verification-request', (event) => {
      const request = event.detail || {};
      if (!request.requestId) return;
      pendingCoverVerifications.set(request.requestId, true);
      GM_setValue(COVER_VERIFICATION_REQUEST_KEY, { requestId: request.requestId, at: Date.now() });
    });

    GM_addValueChangeListener(AUTH_KEY, (k, o, payload, remote) => { if (remote) void sync(payload); });
    GM_addValueChangeListener(COVER_VERIFICATION_RESPONSE_KEY, (k, o, response, remote) => {
      if (!remote || !response?.requestId || !pendingCoverVerifications.has(response.requestId)) return;
      pendingCoverVerifications.delete(response.requestId);
      window.dispatchEvent(new CustomEvent('suno-cover-verification-response', { detail: response }));
    });

    // 初始化通知
    const pending = GM_getValue(AUTH_KEY, null);
    if (pending) void sync(pending);
    if (!usableAuthorization(pending?.headers?.authorization)) requestSync();

    window.dispatchEvent(new CustomEvent('suno-extension-ready', {
      detail: { type: 'auth-sync-upload', version: VERSION, upload: true, localSunoRead: true }
    }));

    function callSunoApi(path, method = 'GET', body) {
      let cancelled = false;
      let cancelWait = () => {};
      let transport = null;

      async function freshHeaders() {
        const cached = GM_getValue(AUTH_KEY, null);
        if (usableAuthorization(cached?.headers?.authorization, 15)) return cached.headers;
        GM_setValue(SYNC_REQUEST_KEY, { at: Date.now() });
        return new Promise((resolve, reject) => {
          const finish = (error, value) => { window.clearInterval(timer); error ? reject(error) : resolve(value); };
          cancelWait = () => finish(new Error('上传请求已取消'));
          const deadline = Date.now() + 15_000;
          const timer = window.setInterval(() => {
            const latest = GM_getValue(AUTH_KEY, null);
            if (usableAuthorization(latest?.headers?.authorization, 10)) finish(null, latest.headers);
            else if (Date.now() >= deadline) finish(new Error('Suno 登录未续期，请打开已登录的 Suno 页面后重试'));
          }, 200);
          if (cancelled) cancelWait();
        });
      }

      const promise = freshHeaders().then((headers) => {
        if (cancelled) throw new Error('上传请求已取消');
        const browserToken = btoa(JSON.stringify({ timestamp: Date.now() }));
        const requestHeaders = { ...headers, 'browser-token': JSON.stringify({ token: browserToken }) };
        Object.keys(requestHeaders).forEach((key) => {
          if (key.toLowerCase() === 'content-type') delete requestHeaders[key];
        });
        requestHeaders['Content-Type'] = 'application/json';
        const requestData = body === undefined ? undefined : JSON.stringify(body);

        return new Promise((resolve, reject) => {
          transport = GM_xmlhttpRequest({
            method: String(method || 'GET').toUpperCase(),
            url: `https://studio-api-prod.suno.com${path}`,
            headers: requestHeaders,
            data: requestData,
            onload: (response) => {
              let result = null;
              try { result = response.responseText ? JSON.parse(response.responseText) : null; } catch { result = response.responseText; }
              if (response.status >= 200 && response.status < 300) resolve(result);
              else {
                const detail = typeof result === 'string' ? result : result?.detail || result?.error || result?.message || response.statusText;
                const error = new Error(`Suno 接口失败 ${response.status}：${detail}`);
                error.status = response.status;
                if (response.status === 401 && !authInvalidated && GM_getValue(AUTH_KEY, null)?.headers?.authorization === headers.authorization) {
                  authInvalidated = true;
                  GM_deleteValue(AUTH_KEY);
                  void fetch('/api/auth?expired=1', { method: 'DELETE', credentials: 'include' }).catch(() => undefined);
                  window.dispatchEvent(new CustomEvent('suno-auth-expired', { detail: { source: 'userscript' } }));
                  GM_setValue(SYNC_REQUEST_KEY, { at: Date.now() });
                }
                reject(error);
              }
            },
            onerror: () => reject(new Error('无法连接 Suno，请检查网络或登录状态')),
            onabort: () => reject(new Error('上传请求已取消')),
            ontimeout: () => reject(new Error('请求 Suno 超时')),
            timeout: 30_000,
          });
        });
      });

      return { promise, abort: () => { cancelled = true; cancelWait(); transport?.abort?.(); } };
    }
  }

  // -------------------------------------------------------------
  // Suno 官方端（suno.com）
  // -------------------------------------------------------------
  function startSunoSync() {
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (pageWindow.__SUNO_CONSOLE_AUTH_SYNC_ACTIVE__) return;
    pageWindow.__SUNO_CONSOLE_AUTH_SYNC_ACTIVE__ = { version: VERSION };

    const headers = {};
    const allowed = ['authorization', 'device-id', 'browser-token', 'referring-pathname', 'referring-url-params', 'referring-origin', 'referring-external-referrer'];
    let lastFingerprint = '';
    let publishing = false;
    let publishAgain = false;
    let forcePublishAgain = false;
    let cachedRootStore = null;

    function currentHeaders() {
      const plusHeaders = pageWindow.__SUNO_BATCH_API_HEADERS__ && typeof pageWindow.__SUNO_BATCH_API_HEADERS__ === 'object' ? pageWindow.__SUNO_BATCH_API_HEADERS__ : {};
      return { ...headers, ...plusHeaders };
    }

    async function publish(force = false) {
      if (publishing) { publishAgain = true; forcePublishAgain ||= force; return; }
      publishing = true;
      try {
        const latest = currentHeaders();
        const cookieAuth = cookieAuthorization(document.cookie);
        if (cookieAuth) latest.authorization = cookieAuth;
        else if (/(?:^|;)\s*__session=/.test(document.cookie)) delete latest.authorization;

        if (pageWindow.Clerk?.loaded && !pageWindow.Clerk.session && !cookieAuth) delete latest.authorization;
        if (pageWindow.Clerk?.session) {
          try {
            let token = null;
            try { token = await pageWindow.Clerk?.session?.getToken?.({ skipCache: force || !usableAuthorization(latest.authorization, 45) }); }
            catch { token = await pageWindow.Clerk?.session?.getToken?.(); }
            if (token) latest.authorization = `Bearer ${token}`;
          } catch { }
        }

        if (!usableAuthorization(latest.authorization)) {
          lastFingerprint = '';
          return;
        }

        const fingerprint = `${latest.authorization}|${latest['device-id'] || ''}`;
        if (!force && fingerprint === lastFingerprint) return;

        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 10_000);
        let response;
        try {
          response = await originalFetch('https://studio-api-prod.suno.com/api/session/', {
            headers: { ...latest, 'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }) },
            signal: controller.signal,
          });
        } finally { window.clearTimeout(timeout); }

        if (!response.ok || !usableAuthorization(latest.authorization)) return;

        lastFingerprint = fingerprint;
        GM_setValue(AUTH_KEY, { headers: latest, capturedAt: Date.now(), version: VERSION });
        console.log('[SunoBridge] Suno 凭据已成功写入油膏存储并广播!');
      } catch (error) {
        console.warn('[SunoBridge] 会话发布未就绪:', error?.message);
      } finally {
        publishing = false;
        if (publishAgain) {
          const forceNext = forcePublishAgain;
          publishAgain = false;
          forcePublishAgain = false;
          void publish(forceNext);
        }
      }
    }

    function remember(source) {
      try {
        const normalized = new pageWindow.Headers(source || {});
        allowed.forEach((key) => {
          const value = normalized.get(key);
          if (value) headers[key] = value;
        });
        if (usableAuthorization(headers.authorization)) void publish();
      } catch { }
    }

    const originalFetch = pageWindow.fetch;
    pageWindow.fetch = function (input, init = {}) {
      const url = typeof input === 'string' ? input : input?.url || String(input || '');
      let isApi = false;
      try { isApi = new URL(url, location.href).origin === 'https://studio-api-prod.suno.com'; } catch { }
      if (isApi) {
        if (input instanceof pageWindow.Request) remember(input.headers);
        remember(init.headers);
      }
      return originalFetch.apply(this, arguments);
    };

    function heartbeat() {
      GM_setValue(HEARTBEAT_KEY, { at: Date.now(), authenticated: usableAuthorization(cookieAuthorization(document.cookie) || currentHeaders().authorization), version: VERSION });
    }

    GM_addValueChangeListener(SYNC_REQUEST_KEY, (k, o, request, remote) => { if (remote && request?.at) void publish(true); });
    GM_addValueChangeListener(COVER_VERIFICATION_REQUEST_KEY, (k, o, request, remote) => {
      if (!remote || !request?.requestId) return;
      void getCoverVerification()
        .then((result) => GM_setValue(COVER_VERIFICATION_RESPONSE_KEY, { requestId: request.requestId, ok: true, result }))
        .catch((error) => GM_setValue(COVER_VERIFICATION_RESPONSE_KEY, { requestId: request.requestId, ok: false, error: error?.message || String(error) }));
    });

    window.setInterval(heartbeat, 10_000);
    window.setInterval(() => void publish(), AUTO_REFRESH_INTERVAL);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); void publish(); } });
    heartbeat();
    window.setTimeout(() => void publish(true), 2_000);

    // 提取 Suno React Fiber 内部人机验证 Token
    async function getCoverVerification() {
      const rootStore = findSunoRootStore();
      if (!rootStore?.session) throw new Error('没有找到 Suno Create 官方验证状态，请在另一标签页打开并刷新 suno.com/create');
      let token = null;
      let tokenProvider = null;
      if (typeof rootStore.session.getCaptchaTokenIfRequired === 'function') {
        token = await rootStore.session.getCaptchaTokenIfRequired('generation');
        tokenProvider = token != null ? rootStore.session.generationCaptchaVersion ?? null : null;
      }
      return {
        token: token == null ? null : String(token),
        tokenProvider,
        createSessionToken: rootStore.genForm?.createSessionToken || null,
        userTier: rootStore.session?.sub?.plan?.id || rootStore.session?.sub?.plans?.find?.((p) => p?.plan_key === 'free')?.id || null,
        pathname: location.pathname || '/create',
      };
    }

    function findSunoRootStore() {
      if (cachedRootStore?.session) return cachedRootStore;
      const seen = new WeakSet();
      const isObject = (v) => v && (typeof v === 'object' || typeof v === 'function');
      const directRoot = (v) => {
        if (v?.genForm?.setCoverClip) return v;
        if (v?.root?.genForm?.setCoverClip) return v.root;
        if (v?.value?.genForm?.setCoverClip) return v.value;
        if (v?.value?.root?.genForm?.setCoverClip) return v.value.root;
        return null;
      };
      const scan = (v, depth = 0) => {
        if (!isObject(v) || seen.has(v) || depth > 6) return null;
        seen.add(v);
        const direct = directRoot(v);
        if (direct) return direct;
        let keys = [];
        try { keys = Object.keys(v); } catch { return null; }
        for (const key of keys) {
          if (['return', 'alternate', 'stateNode', '_debugOwner'].includes(key)) continue;
          try {
            const found = scan(v[key], depth + 1);
            if (found) return found;
          } catch { }
        }
        return null;
      };

      for (const node of document.querySelectorAll('body, body *')) {
        for (const key of Object.keys(node).filter((n) => /^__react(?:Fiber|Props|Container)\$/.test(n))) {
          const found = scan(node[key]);
          if (found) {
            cachedRootStore = found;
            return found;
          }
        }
      }
      return null;
    }
  }
})();
