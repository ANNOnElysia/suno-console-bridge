/**
 * Suno Console Bridge - 前端调度核心
 * 实现与油猴脚本事件协议的双向通讯与 S3 直传调度
 */

class BridgeClient {
  constructor() {
    this.selectedFile = null;
    this.isBridgeReady = false;
    this.sunoAuth = null;
    this.pendingRequests = new Map();

    this.initElements();
    this.bindEvents();
    this.startDetection();
  }

  log(message, type = 'info') {
    const container = document.getElementById('console-logs');
    if (!container) return;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">[${time}]</span> ${this.escapeHtml(message)}`;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  }

  escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  initElements() {
    this.bridgeBadge = document.getElementById('bridge-badge');
    this.bridgeVersion = document.getElementById('bridge-version');
    this.bridgeStatusText = document.getElementById('bridge-status-text');
    this.authStatusBadge = document.getElementById('auth-status-badge');
    this.accountName = document.getElementById('account-name');
    this.accountDetail = document.getElementById('account-detail');

    this.dropZone = document.getElementById('drop-zone');
    this.audioInput = document.getElementById('audio-input');
    this.fileInfo = document.getElementById('file-info');
    this.fileName = document.getElementById('file-name');
    this.fileSize = document.getElementById('file-size');
    this.btnRemoveFile = document.getElementById('btn-remove-file');

    this.uploadForm = document.getElementById('upload-form');
    this.btnStartUpload = document.getElementById('btn-start-upload');
    this.btnRequestSync = document.getElementById('btn-request-sync');
    this.btnTestCaptcha = document.getElementById('btn-test-captcha');
    this.btnClearLog = document.getElementById('btn-clear-log');

    this.progressContainer = document.getElementById('progress-container');
    this.progressStep = document.getElementById('progress-step');
    this.progressPercent = document.getElementById('progress-percent');
    this.progressBarFill = document.getElementById('progress-bar-fill');
  }

  bindEvents() {
    // 监听油猴脚本广播的全局事件
    window.addEventListener('suno-extension-ready', (e) => this.onExtensionReady(e.detail));
    window.addEventListener('suno-auth-synced', (e) => this.onAuthSynced(e.detail));
    window.addEventListener('suno-auth-expired', () => this.onAuthExpired());

    // 监听油猴脚本对 API 调用的响应
    window.addEventListener('suno-console-upload-response', (e) => {
      const { requestId, ok, result, error, status } = e.detail || {};
      const callback = this.pendingRequests.get(requestId);
      if (callback) {
        this.pendingRequests.delete(requestId);
        if (ok) callback.resolve(result);
        else callback.reject(new Error(error || `Suno API 响应错误 (状态码: ${status})`));
      }
    });

    // 监听油猴脚本对 Captcha 验证的响应
    window.addEventListener('suno-cover-verification-response', (e) => {
      const { requestId, ok, result, error } = e.detail || {};
      const callback = this.pendingRequests.get(requestId);
      if (callback) {
        this.pendingRequests.delete(requestId);
        if (ok) callback.resolve(result);
        else callback.reject(new Error(error || '获取 Cover 验证失败'));
      }
    });

    // 拖拽与文件选择
    this.dropZone.addEventListener('click', (e) => {
      if (!this.selectedFile) this.audioInput.click();
    });
    this.audioInput.addEventListener('change', (e) => this.handleFileSelect(e.target.files[0]));
    this.btnRemoveFile.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearFile();
    });

    this.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); this.dropZone.classList.add('dragover'); });
    this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('dragover'));
    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) this.handleFileSelect(e.dataTransfer.files[0]);
    });

    // 表单提交
    this.uploadForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.startUploadPipeline();
    });

    // 功能按钮
    this.btnRequestSync.addEventListener('click', () => {
      this.log('手动派发 suno-auth-sync-request 同步指令...', 'info');
      window.dispatchEvent(new CustomEvent('suno-auth-sync-request'));
    });

    this.btnTestCaptcha.addEventListener('click', () => this.testCaptcha());
    this.btnClearLog.addEventListener('click', () => {
      document.getElementById('console-logs').innerHTML = '';
      this.log('日志已清空', 'info');
    });
  }

  startDetection() {
    // 轮询检测油猴注入标记
    const checkTimer = setInterval(() => {
      if (window.__SUNO_CONSOLE_BRIDGE__) {
        clearInterval(checkTimer);
        this.onExtensionReady(window.__SUNO_CONSOLE_BRIDGE__);
      }
    }, 500);

    // 定期从后端拉取已保存的会话状态
    this.refreshBackendSession();
    setInterval(() => this.refreshBackendSession(), 10000);
  }

  onExtensionReady(bridgeInfo) {
    if (this.isBridgeReady) return;
    this.isBridgeReady = true;
    this.bridgeBadge.className = 'badge badge-success';
    this.bridgeBadge.innerHTML = '<span class="dot"></span><span class="badge-text">油猴桥接就绪</span>';
    this.bridgeVersion.textContent = `v${bridgeInfo?.version || '1.3.x'}`;
    this.bridgeStatusText.textContent = '✔ 油猴扩展通信正常';
    this.bridgeStatusText.style.color = '#34d399';
    this.log(`油猴桥接脚本已连接 (版本: ${bridgeInfo?.version || '未知'})`, 'success');
    this.checkFormState();
  }

  async refreshBackendSession() {
    try {
      const res = await fetch('/api/session');
      if (!res.ok) return;
      const data = await res.json();
      const user = data.user;

      if (user && user.isOnline) {
        this.sunoAuth = user;
        this.authStatusBadge.className = 'badge badge-success';
        this.authStatusBadge.textContent = '已登录';
        this.accountName.textContent = user.displayName || user.id;
        this.accountDetail.textContent = `已捕获 Suno 凭据 · 更新于 ${new Date(user.capturedAt).toLocaleTimeString()}`;
      } else {
        this.sunoAuth = null;
        this.authStatusBadge.className = 'badge badge-gray';
        this.authStatusBadge.textContent = '未同步';
        this.accountName.textContent = '等待 Suno 登录同步';
        this.accountDetail.textContent = '请打开并登录 suno.com，脚本会自动捕获凭据';
      }
      this.checkFormState();
    } catch (e) {
      // 忽略轮询失败
    }
  }

  onAuthSynced(authDetail) {
    this.log(`接收到 Suno 认证同步广播: 用户 ${authDetail?.userId || ''}`, 'success');
    this.refreshBackendSession();
  }

  onAuthExpired() {
    this.log('Suno 登录凭证已过期，请重新登录 Suno 官网', 'warn');
    this.refreshBackendSession();
  }

  handleFileSelect(file) {
    if (!file || !file.type.startsWith('audio/')) {
      alert('请选择有效的音频文件 (MP3, WAV, FLAC, M4A, OGG)');
      return;
    }
    this.selectedFile = file;
    this.fileName.textContent = file.name;
    const mb = (file.size / (1024 * 1024)).toFixed(2);
    this.fileSize.textContent = `${mb} MB · ${file.type || 'audio'}`;
    document.querySelector('.drop-zone-content').style.display = 'none';
    this.fileInfo.style.display = 'flex';

    // 自动填充标题
    const titleInput = document.getElementById('song-title');
    if (!titleInput.value) {
      titleInput.value = file.name.replace(/\.[^/.]+$/, "");
    }
    this.log(`已加载待上传音频: ${file.name} (${mb} MB)`, 'info');
    this.checkFormState();
  }

  clearFile() {
    this.selectedFile = null;
    this.audioInput.value = '';
    this.fileInfo.style.display = 'none';
    document.querySelector('.drop-zone-content').style.display = 'block';
    this.checkFormState();
  }

  checkFormState() {
    const canSubmit = this.isBridgeReady && this.selectedFile && this.sunoAuth;
    this.btnStartUpload.disabled = !canSubmit;
    if (!this.sunoAuth) {
      this.btnStartUpload.querySelector('span').textContent = '请先在 Suno 官网登录以同步凭据';
    } else if (!this.selectedFile) {
      this.btnStartUpload.querySelector('span').textContent = '请选择或拖入音频文件';
    } else if (!this.isBridgeReady) {
      this.btnStartUpload.querySelector('span').textContent = '等待油猴脚本就绪...';
    } else {
      this.btnStartUpload.querySelector('span').textContent = '立即执行直传流程';
    }
  }

  // Promise 化调用油猴的 callSunoApi 桥接
  callSunoBridge(path, method = 'GET', body = undefined) {
    return new Promise((resolve, reject) => {
      const requestId = 'req_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('油猴脚本响应超时'));
        }
      }, 35000);

      this.pendingRequests.set(requestId, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });

      window.dispatchEvent(new CustomEvent('suno-console-upload-request', {
        detail: { requestId, path, method, body }
      }));
    });
  }

  // 测试提取 Suno React 内部 Captcha
  async testCaptcha() {
    this.log('正在请求从 Suno 页面提取 React 内部 Captcha...', 'info');
    const requestId = 'cap_' + Math.random().toString(36).substr(2, 9);
    try {
      const promise = new Promise((resolve, reject) => {
        this.pendingRequests.set(requestId, { resolve, reject });
        window.dispatchEvent(new CustomEvent('suno-cover-verification-request', { detail: { requestId } }));
        setTimeout(() => {
          if (this.pendingRequests.has(requestId)) {
            this.pendingRequests.delete(requestId);
            reject(new Error('获取 Captcha 超时，请确认打开了 suno.com/create 页面'));
          }
        }, 15000);
      });

      const res = await promise;
      this.log(`✔ Captcha 获取成功! Token: ${res.token ? res.token.slice(0, 20) + '...' : '(不需要)'}, Tier: ${res.userTier || 'N/A'}`, 'success');
    } catch (err) {
      this.log(`❌ Captcha 获取失败: ${err.message}`, 'error');
    }
  }

  // 完整的直传流水线
  async startUploadPipeline() {
    if (!this.selectedFile) return;

    this.btnStartUpload.disabled = true;
    this.progressContainer.style.display = 'block';
    this.updateProgress('准备上传任务...', 5);

    try {
      const file = this.selectedFile;
      const title = document.getElementById('song-title').value.trim() || file.name;
      const tags = document.getElementById('song-tags').value.trim();
      const lyrics = document.getElementById('song-lyrics').value.trim();
      const isInstrumental = document.getElementById('is-instrumental').checked;
      const requireCaptcha = document.getElementById('require-captcha').checked;

      // 阶段 1：获取 Captcha / Cover 验证
      let captchaToken = null;
      if (requireCaptcha) {
        this.updateProgress('正在提取 Suno 内部会话验证...', 15);
        this.log('[阶段 1/4] 申请 Suno 内部生成凭证...', 'info');
        try {
          const capResult = await this.getCaptchaToken();
          captchaToken = capResult?.token || null;
          this.log(`✔ 成功获得验证上下文 (Token 状态: ${Boolean(captchaToken)})`, 'success');
        } catch (e) {
          this.log(`⚠ 获取验证跳过或失败 (${e.message})，尝试直接上传...`, 'warn');
        }
      }

      // 阶段 2：向 Suno 申请预签名上传 URL
      this.updateProgress('向 Suno 申请 S3 预签名直传地址...', 30);
      this.log('[阶段 2/4] 请求预签名直传地址...', 'info');

      // 探测/使用 Suno 上传配置端点
      const uploadInitPayload = {
        title: title,
        filename: file.name,
        size: file.size,
        mime_type: file.type || 'audio/mpeg'
      };

      const uploadConfig = await this.callSunoBridge('/api/uploads/audio/', 'POST', uploadInitPayload)
        .catch(() => this.callSunoBridge('/api/c/clips/upload/', 'POST', uploadInitPayload));

      this.log(`✔ 获得 S3 上传预签名凭据`, 'success');
      console.log('Upload config:', uploadConfig);

      const targetUrl = uploadConfig?.url || uploadConfig?.upload_url || uploadConfig?.signed_url;
      const clipId = uploadConfig?.clip_id || uploadConfig?.id;

      if (!targetUrl) {
        throw new Error('Suno 接口未返回有效的预签名直传 URL');
      }

      // 阶段 3：浏览器本地直接二进制 PUT 到 S3
      this.updateProgress('正在将音频二进制流直传至 AWS S3...', 40);
      this.log(`[阶段 3/4] 启动浏览器 S3 直传 (文件大小: ${(file.size / 1024 / 1024).toFixed(2)} MB)...`, 'info');

      await this.uploadDirectToS3(targetUrl, file, (percent) => {
        const scaled = 40 + Math.round(percent * 0.45);
        this.updateProgress(`直传 S3 进度: ${percent}%`, scaled);
      });

      this.log(`✔ S3 二进制流直传完成!`, 'success');

      // 阶段 4：通知 Suno 确认上传并挂载元数据
      this.updateProgress('正在向 Suno 提交生成/保存确认...', 90);
      this.log('[阶段 4/4] 提交最终音频作品保存与确认...', 'info');

      const finalizePayload = {
        clip_id: clipId,
        title: title,
        tags: tags,
        prompt: lyrics,
        instrumental: isInstrumental,
        token: captchaToken
      };

      const finalResult = await this.callSunoBridge(`/api/uploads/audio/${clipId}/complete/`, 'POST', finalizePayload)
        .catch(() => this.callSunoBridge('/api/c/clips/upload/complete/', 'POST', finalizePayload));

      this.updateProgress('🎉 音频上传成功并已入库!', 100);
      this.log(`🎉 任务完成! Clip ID: ${clipId || '已生成'}, 现可在 Suno 工作台中查看。`, 'success');
      alert(`🎉 恭喜！音频「${title}」已成功直传至 Suno！`);

    } catch (error) {
      this.log(`❌ 上传流水线中止: ${error.message}`, 'error');
      alert(`上传失败: ${error.message}`);
      this.updateProgress('上传失败', 0);
    } finally {
      this.btnStartUpload.disabled = false;
      this.checkFormState();
    }
  }

  // S3 PUT 直传
  uploadDirectToS3(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress(percent);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`S3 上传响应失败 (HTTP ${xhr.status})`));
      };

      xhr.onerror = () => reject(new Error('S3 网络直传错误，请检查网络连接'));
      xhr.onabort = () => reject(new Error('S3 上传已取消'));
      xhr.send(file);
    });
  }

  getCaptchaToken() {
    return new Promise((resolve, reject) => {
      const requestId = 'req_cap_' + Date.now();
      this.pendingRequests.set(requestId, { resolve, reject });
      window.dispatchEvent(new CustomEvent('suno-cover-verification-request', { detail: { requestId } }));
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('获取验证超时'));
        }
      }, 10000);
    });
  }

  updateProgress(text, percent) {
    this.progressStep.textContent = text;
    this.progressPercent.textContent = `${percent}%`;
    this.progressBarFill.style.width = `${percent}%`;
  }
}

// 页面加载后启动
window.addEventListener('DOMContentLoaded', () => {
  window.bridgeApp = new BridgeClient();
});
