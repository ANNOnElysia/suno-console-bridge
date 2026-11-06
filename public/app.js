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

  dispatchBridgeEvent(eventName, detail = {}) {
    const eventInit = { detail };
    try { document.dispatchEvent(new CustomEvent(eventName, eventInit)); } catch {}
    try { window.dispatchEvent(new CustomEvent(eventName, eventInit)); } catch {}
  }

  listenBridgeEvent(eventName, handler) {
    const handledMap = new Set();
    const wrapped = (e) => {
      const detail = e.detail || {};
      if (detail.requestId) {
        const key = `${eventName}:${detail.requestId}`;
        if (handledMap.has(key)) return;
        handledMap.add(key);
        setTimeout(() => handledMap.delete(key), 20000);
      }
      handler(detail);
    };
    document.addEventListener(eventName, wrapped);
    window.addEventListener(eventName, wrapped);
  }

  bindEvents() {
    this.tosCheckbox = document.getElementById('accept-upload-tos');
    this.tosCheckbox.addEventListener('change', () => this.checkFormState());

    // 监听油猴脚本广播的全局事件（双通道监听 document & window）
    this.listenBridgeEvent('suno-extension-ready', (detail) => this.onExtensionReady(detail));
    this.listenBridgeEvent('suno-auth-synced', (detail) => this.onAuthSynced(detail));
    this.listenBridgeEvent('suno-auth-expired', () => this.onAuthExpired());

    // 监听油猴脚本对 API 调用的响应
    this.listenBridgeEvent('suno-console-upload-response', (detail) => {
      const { requestId, ok, result, error, status } = detail || {};
      const callback = this.pendingRequests.get(requestId);
      if (callback) {
        this.pendingRequests.delete(requestId);
        if (ok) callback.resolve(result);
        else callback.reject(Object.assign(new Error(error || `Suno API 响应错误 (状态码: ${status})`), { status }));
      }
    });

    // 监听油猴脚本对 Captcha 验证的响应
    this.listenBridgeEvent('suno-cover-verification-response', (detail) => {
      const { requestId, ok, result, error } = detail || {};
      const callback = this.pendingRequests.get(requestId);
      if (callback) {
        this.pendingRequests.delete(requestId);
        if (ok) callback.resolve(result);
        else callback.reject(new Error(error || '获取 Cover 验证失败'));
      }
    });

    // 监听油猴脚本对 S3 上传进度的反馈
    this.listenBridgeEvent('suno-console-s3-upload-progress', (detail) => {
      const { requestId, percent } = detail || {};
      const callback = this.pendingRequests.get(requestId);
      if (callback && callback.onProgress) {
        callback.onProgress(percent);
      }
    });

    // 监听油猴脚本对 S3 上传结果的反馈
    this.listenBridgeEvent('suno-console-s3-upload-response', (detail) => {
      const { requestId, ok, error } = detail || {};
      const callback = this.pendingRequests.get(requestId);
      if (callback) {
        this.pendingRequests.delete(requestId);
        if (ok) callback.resolve();
        else callback.reject(new Error(error || 'S3 直传错误'));
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
      this.dispatchBridgeEvent('suno-auth-sync-request');
    });

    this.btnTestCaptcha.addEventListener('click', () => this.testCaptcha());
    this.btnClearLog.addEventListener('click', () => {
      document.getElementById('console-logs').innerHTML = '';
      this.log('日志已清空', 'info');
    });
  }

  startDetection() {
    const checkBridge = () => {
      if (this.isBridgeReady) return;
      const attrReady = document.documentElement.getAttribute('data-suno-bridge-ready') === 'true';
      let bridgeObj = null;
      try { bridgeObj = window.__SUNO_CONSOLE_BRIDGE__; } catch {}
      if (bridgeObj || attrReady) {
        const version = bridgeObj?.version || document.documentElement.getAttribute('data-suno-bridge-version') || '1.0.0';
        this.onExtensionReady({ version, type: 'auth-sync-upload', upload: true, localSunoRead: true });
      }
    };

    // 立即检查
    checkBridge();

    // 轮询检测油猴注入标记与 DOM 属性，并主动发送 ping
    const checkTimer = setInterval(() => {
      if (this.isBridgeReady) {
        clearInterval(checkTimer);
        return;
      }
      checkBridge();
      this.dispatchBridgeEvent('suno-console-ping');
    }, 400);

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
    const canSubmit = this.isBridgeReady && this.selectedFile && this.sunoAuth && this.tosCheckbox.checked;
    this.btnStartUpload.disabled = !canSubmit;
    if (!this.sunoAuth) {
      this.btnStartUpload.querySelector('span').textContent = '请先在 Suno 官网登录以同步凭据';
    } else if (!this.selectedFile) {
      this.btnStartUpload.querySelector('span').textContent = '请选择或拖入音频文件';
    } else if (!this.isBridgeReady) {
      this.btnStartUpload.querySelector('span').textContent = '等待油猴脚本就绪...';
    } else if (!this.tosCheckbox.checked) {
      this.btnStartUpload.querySelector('span').textContent = '请先确认上传权利与 Suno 条款';
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

      this.dispatchBridgeEvent('suno-console-upload-request', { requestId, path, method, body });
    });
  }

  // 测试提取 Suno React 内部 Captcha
  async testCaptcha() {
    this.log('正在请求从 Suno 页面提取 React 内部 Captcha...', 'info');
    const requestId = 'cap_' + Math.random().toString(36).substr(2, 9);
    try {
      const promise = new Promise((resolve, reject) => {
        this.pendingRequests.set(requestId, { resolve, reject });
        this.dispatchBridgeEvent('suno-cover-verification-request', { requestId });
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
      let file = this.selectedFile;
      const title = document.getElementById('song-title').value.trim() || file.name;
      const tags = document.getElementById('song-tags').value.trim();
      const lyrics = document.getElementById('song-lyrics').value.trim();
      const isInstrumental = document.getElementById('is-instrumental').checked;
      const requireCaptcha = document.getElementById('require-captcha').checked;
      const bypassAcr = document.getElementById('bypass-acrcloud')?.checked;

      // 阶段 0：声学特征脱敏处理 (微调速度/变调错开 ACRCloud 指纹识别)
      if (bypassAcr) {
        this.updateProgress('正在执行音频声学脱敏...', 10);
        this.log('[阶段 0/4] 启动浏览器本地声学特征脱敏 (破坏 ACRCloud 指纹)...', 'info');
        try {
          file = await this.anonymizeAudio(file);
          this.log(`✔ 声学脱敏完成! 生成免检音频包 (${(file.size / 1024 / 1024).toFixed(2)} MB)`, 'success');
        } catch (e) {
          this.log(`⚠ 声学脱敏失败 (${e.message})，将使用原始音频继续尝试...`, 'warn');
        }
      }

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

      const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
      if (!extension) throw new Error('文件名缺少扩展名，无法告知 Suno 音频格式');

      const uploadConfig = await this.callSunoBridge('/api/uploads/audio/', 'POST', {
        extension,
        is_stem_mix: false,
        upload_type: 'file_upload'
      });

      this.log(`✔ 获得 S3 上传预签名凭据`, 'success');
      console.log('Upload config:', uploadConfig);

      const targetUrl = uploadConfig?.url || uploadConfig?.upload_url || uploadConfig?.signed_url;
      const uploadId = uploadConfig?.id;

      this.log(`调试信息 - S3 目标地址: ${targetUrl ? targetUrl.slice(0, 60) + '...' : '空'}`, 'info');
      console.log('完整 uploadConfig 响应:', uploadConfig);

      if (!targetUrl) {
        throw new Error('Suno 接口未返回有效的预签名直传 URL: ' + JSON.stringify(uploadConfig));
      }

      // 阶段 3：浏览器本地直接直传到 S3（支持 PUT 与 POST 表单多部分模式）
      this.updateProgress('正在将音频直传至 AWS S3...', 40);
      this.log(`[阶段 3/4] 启动 S3 表单直传 (文件大小: ${(file.size / 1024 / 1024).toFixed(2)} MB)...`, 'info');

      await this.uploadDirectToS3(targetUrl, file, uploadConfig?.fields || null, (percent) => {
        const scaled = 40 + Math.round(percent * 0.45);
        this.updateProgress(`直传 S3 进度: ${percent}%`, scaled);
      });

      this.log(`✔ S3 直传完成!`, 'success');

      // 阶段 4：通知 Suno 确认上传完成并入库
      this.updateProgress('正在向 Suno 提交入库确认...', 90);
      this.log('[阶段 4/4] 提交上传结束通知 (upload-finish)...', 'info');

      await this.callSunoBridge(`/api/uploads/audio/${uploadId}/upload-finish/`, 'POST', {
        upload_type: 'file_upload',
        upload_filename: file.name,
        agreed_to_vip_upload_terms: false
      });

      // 等待 Suno 的完整检查（含音频处理与曲库比对），只有 complete 才能初始化 Clip
      this.updateProgress('等待 Suno 后台检查音频...', 92);
      this.log('正在等待 Suno 后台检查音频文件...', 'info');
      await this.waitForUploadComplete(uploadId);

      // 创建音频条目
      this.updateProgress('正在入库创建歌曲...', 96);
      this.log('正在初始化音频 Clip (initialize-clip)...', 'info');
      const initialized = await this.callSunoBridge(`/api/uploads/audio/${uploadId}/initialize-clip/`, 'POST', {
        user_reviewed_tags: true
      });
      const generatedClipId = initialized?.clip_id || initialized?.clip?.id;
      if (!generatedClipId) {
        throw new Error('initialize-clip 未返回 clip_id: ' + JSON.stringify(initialized));
      }

      // 写入标题、歌词，并提交用户勾选的上传条款确认
      this.updateProgress('正在写入歌曲信息...', 98);
      const metadata = { title, is_audio_upload_tos_accepted: true };
      if (lyrics && !isInstrumental) metadata.lyrics = lyrics;
      if (tags) this.log('⚠ Suno 的 set_metadata 没有已知的风格字段，Tags 未写入', 'warn');
      try {
        await this.callSunoBridge(`/api/gen/${generatedClipId}/set_metadata/`, 'POST', metadata);
      } catch (metaErr) {
        throw new Error(`Clip ${generatedClipId} 已创建，但写入歌曲信息失败: ${metaErr.message}`);
      }

      this.updateProgress('🎉 音频上传成功并已入库!', 100);
      this.log(`🎉 任务完成! Clip ID: ${generatedClipId}, 现已成功入库 Suno!`, 'success');
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

  // 轮询上传状态直到 complete；passed_audio_processing 只是中间状态
  async waitForUploadComplete(uploadId, { intervalMs = 3000, timeoutMs = 180000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, intervalMs));
      let res;
      try {
        res = await this.callSunoBridge(`/api/uploads/audio/${uploadId}/`, 'GET');
      } catch (err) {
        if (err.status === 404) throw new Error('Suno 已不存在此上传记录 (404)');
        this.log(`⚠ 状态查询失败，继续重试: ${err.message}`, 'warn');
        continue;
      }
      const status = res?.status;
      if (status !== lastStatus) {
        this.log(`Suno 处理状态: ${status || '未知'}`, 'info');
        lastStatus = status;
      }
      if (status === 'complete' || status === 'completed') return res;
      if (status === 'error') {
        const reason = [res.error_type, res.error_message].filter(Boolean).join(': ');
        throw new Error(`Suno 拒绝了这个音频: ${reason || JSON.stringify(res)}`);
      }
    }
    throw new Error(`等待 Suno 检查超时，最后状态: ${lastStatus || '未知'}`);
  }

  // S3 直传（优先通过油猴 GM_xmlhttpRequest 绕过浏览器同源 CORS 限制，同时支持 fields 表单与单一 PUT）
  uploadDirectToS3(url, file, fields, onProgress) {
    return new Promise((resolve, reject) => {
      const requestId = 's3_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        onProgress
      });

      // 派发事件交由油猴脚本处理
      this.dispatchBridgeEvent('suno-console-s3-upload-request', {
        requestId,
        url,
        file,
        fields: fields || null,
        contentType: file.type || 'audio/mpeg'
      });

      // 超时保护
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('S3 直传响应超时'));
        }
      }, 190000);
    });
  }

  getCaptchaToken() {
    return new Promise((resolve, reject) => {
      const requestId = 'req_cap_' + Date.now();
      this.pendingRequests.set(requestId, { resolve, reject });
      this.dispatchBridgeEvent('suno-cover-verification-request', { requestId });
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

  // 声学脱敏算法：利用 Web Audio API 动态轻微变调 (+0.7 半音) 并重新编码为 WAV
  // 彻底破坏 ACRCloud 的峰值频率哈希对与时间间隔对齐，同时人耳听感几乎无感
  async anonymizeAudio(file) {
    const arrayBuffer = await file.arrayBuffer();
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const originalBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    await tempCtx.close();

    // 变调比率：+0.7 半音 = 2^(0.7/12) ≈ 1.04128
    const playbackRate = 1.04128;
    const newLength = Math.floor(originalBuffer.length / playbackRate);
    const offlineCtx = new OfflineAudioContext(
      originalBuffer.numberOfChannels,
      newLength,
      originalBuffer.sampleRate
    );

    const source = offlineCtx.createBufferSource();
    source.buffer = originalBuffer;
    source.playbackRate.value = playbackRate;

    // 轻微高通滤波移除可能暴露指纹的超低频噪声 (< 25Hz)
    const filter = offlineCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 25;

    source.connect(filter);
    filter.connect(offlineCtx.destination);

    source.start(0);
    const renderedBuffer = await offlineCtx.startRendering();

    // 转换为标准 WAV Blob
    const wavBlob = this.audioBufferToWav(renderedBuffer);
    const baseName = file.name.replace(/\.[^/.]+$/, "");
    return new File([wavBlob], `${baseName}_anonymized.wav`, { type: 'audio/wav' });
  }

  // 将 AudioBuffer 打包为标准 16-bit PCM WAV 容器
  audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    
    let interleaved;
    if (numChannels === 2) {
      interleaved = this.interleave(buffer.getChannelData(0), buffer.getChannelData(1));
    } else {
      interleaved = buffer.getChannelData(0);
    }
    
    const bufferLength = 44 + interleaved.length * 2;
    const outBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(outBuffer);

    // RIFF chunk descriptor
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + interleaved.length * 2, true);
    this.writeString(view, 8, 'WAVE');
    
    // FMT sub-chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);
    
    // Data sub-chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, interleaved.length * 2, true);

    // 写入 16-bit PCM 音频数据
    let offset = 44;
    for (let i = 0; i < interleaved.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, interleaved[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([outBuffer], { type: 'audio/wav' });
  }

  interleave(inputL, inputR) {
    const length = inputL.length + inputR.length;
    const result = new Float32Array(length);
    let index = 0;
    let inputIndex = 0;
    while (index < length) {
      result[index++] = inputL[inputIndex];
      result[index++] = inputR[inputIndex];
      inputIndex++;
    }
    return result;
  }

  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

// 页面加载后启动
window.addEventListener('DOMContentLoaded', () => {
  window.bridgeApp = new BridgeClient();
});
