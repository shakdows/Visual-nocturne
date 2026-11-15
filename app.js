'use strict';
const $ = (id) => document.getElementById(id);
const video = $('src'), canvas = $('view'), statusEl = $('status');

const state = {
  facing: 'environment', stream: null, mode: 'photo',
  auto: true, gain: 1, green: false,
  recorder: null, chunks: [], recStart: 0, recTimer: 0,
  boosted: false, firstFrame: true,
};

/* ---------- Avisos ---------- */
let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
function showError(text) { $('msgText').textContent = text; $('msg').hidden = false; }

/* ---------- Procesado de imagen (WebGL2) ----------
   1) Promedia fotogramas consecutivos para reducir el ruido del sensor.
   2) Amplifica la luz con una curva que levanta las sombras sin quemar las luces. */
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;
const FS_ACC = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D cur, prev; uniform float a;
void main(){ o = vec4(mix(texture(prev, uv).rgb, texture(cur, uv).rgb, a), 1.); }`;
const FS_OUT = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D t; uniform float g, green;
void main(){
  vec3 c = texture(t, uv).rgb;
  c = c * g / (1. + c * (g - 1.));
  float l = dot(c, vec3(.299, .587, .114));
  o = vec4(mix(c, vec3(.16, 1., .32) * l, green), 1.);
}`;

let gl = null, ctx2d = null, progAcc, progOut, texCur, fbo = [], tex = [], flip = 0, floatTargets = false;

function program(fsSrc) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function newTexture() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return t;
}
function initGL() {
  try {
    gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
    if (!gl) throw new Error('sin WebGL2');
    progAcc = program(FS_ACC); progOut = program(FS_OUT);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    floatTargets = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    texCur = newTexture();
  } catch (e) {
    console.warn('WebGL no disponible, modo básico:', e);
    gl = null;
    ctx2d = canvas.getContext('2d');
  }
}
function allocTargets(w, h) {
  for (let i = 0; i < 2; i++) {
    if (tex[i]) gl.deleteTexture(tex[i]);
    if (fbo[i]) gl.deleteFramebuffer(fbo[i]);
    tex[i] = newTexture();
    if (floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    fbo[i] = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[i], 0);
    if (floatTargets && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      floatTargets = false; return allocTargets(w, h);
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function render() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h || video.readyState < 2) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    if (gl) allocTargets(w, h);
    state.firstFrame = true;
  }
  const g = state.gain;
  if (!gl) {
    if ('filter' in ctx2d) ctx2d.filter = `brightness(${g})${state.green ? ' grayscale(1) sepia(1) hue-rotate(70deg) saturate(3)' : ''}`;
    ctx2d.drawImage(video, 0, 0, w, h);
    return;
  }
  // Más amplificación => más fotogramas promediados (menos ruido, algo más de estela).
  let a = Math.min(1, Math.max(floatTargets ? 0.12 : 0.5, 1 / (g * 0.8)));
  if (state.firstFrame) { a = 1; state.firstFrame = false; }
  gl.viewport(0, 0, w, h);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texCur);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex[flip]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - flip]);
  gl.useProgram(progAcc);
  gl.uniform1i(gl.getUniformLocation(progAcc, 'cur'), 0);
  gl.uniform1i(gl.getUniformLocation(progAcc, 'prev'), 1);
  gl.uniform1f(gl.getUniformLocation(progAcc, 'a'), a);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  flip = 1 - flip;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex[flip]);
  gl.useProgram(progOut);
  gl.uniform1i(gl.getUniformLocation(progOut, 't'), 0);
  gl.uniform1f(gl.getUniformLocation(progOut, 'g'), g);
  gl.uniform1f(gl.getUniformLocation(progOut, 'green'), state.green ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
function loop() {
  render();
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}

/* ---------- Luz automática ---------- */
const probe = document.createElement('canvas'); probe.width = 32; probe.height = 18;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });
function measure() {
  if (!video.videoWidth || document.hidden) return;
  probeCtx.drawImage(video, 0, 0, 32, 18);
  const d = probeCtx.getImageData(0, 0, 32, 18).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const mean = sum / (d.length / 4) / 255;
  if (state.auto) {
    const target = Math.min(10, Math.max(1, 0.42 / Math.max(mean, 0.01)));
    state.gain += (target - state.gain) * 0.35;
    if (state.gain < 1.08) state.gain = 1;
    $('gain').value = state.gain;
  }
  boostSensor();
  updateStatus();
}
// Pide al sensor la máxima exposición cuando hay poca luz (si el celular lo permite).
function boostSensor() {
  const track = state.stream && state.stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.exposureCompensation) return;
  const want = state.boosted ? state.gain > 1.15 : state.gain > 2.5;
  if (want === state.boosted) return;
  state.boosted = want;
  track.applyConstraints({ advanced: [{ exposureCompensation: want ? caps.exposureCompensation.max : 0 }] }).catch(() => {});
}
function updateStatus() {
  if (state.recorder) return;
  statusEl.classList.remove('rec');
  statusEl.textContent = state.gain > 1.05 ? `Noche ×${state.gain.toFixed(1)}` : 'Luz normal';
}

/* ---------- Cámara ---------- */
async function startCamera() {
  $('msg').hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return showError('Este navegador no da acceso a la cámara. Abre la app con https:// en Chrome o Safari.');
  }
  stopCamera();
  const v = { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } };
  try {
    try { state.stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: true }); }
    catch (e) {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: v });
      toast('Sin micrófono: los videos se grabarán sin sonido.');
    }
  } catch (e) {
    return showError(e.name === 'NotAllowedError'
      ? 'Necesito permiso para usar la cámara. Actívalo en los ajustes del navegador y vuelve a intentar.'
      : 'No pude abrir la cámara: ' + (e.message || e.name));
  }
  video.srcObject = state.stream;
  state.firstFrame = true; state.boosted = false;
  await video.play().catch(() => {});
  canvas.classList.toggle('mirror', state.facing === 'user');
  const track = state.stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  $('torch').disabled = !caps.torch;
  $('torch').setAttribute('aria-pressed', 'false');
  if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
}
function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

/* ---------- Guardado ---------- */
const stamp = () => {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};
function download(item) {
  const url = URL.createObjectURL(item.blob);
  const a = document.createElement('a');
  a.href = url; a.download = item.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
let dbPromise;
function db() {
  return dbPromise || (dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('visual-nocturne', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('media', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('media', mode), rq = fn(tx.objectStore('media'));
    tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error);
  });
}
let items = [];
async function saveCapture(blob, ext) {
  const item = { id: Date.now(), name: `nocturne-${stamp()}.${ext}`, type: blob.type, blob };
  items.unshift(item);
  setThumb();
  download(item);
  try { await store('readwrite', (s) => s.put(item)); } catch (e) { console.warn('IndexedDB:', e); }
  toast(`Guardado: ${item.name}`);
}
function setThumb() {
  const last = items.find((i) => i.type.startsWith('image/'));
  const t = $('thumb');
  if (t.dataset.url) URL.revokeObjectURL(t.dataset.url);
  if (last) {
    t.dataset.url = URL.createObjectURL(last.blob);
    t.style.backgroundImage = `url(${t.dataset.url})`;
    t.firstElementChild.style.display = 'none';
  } else {
    t.style.backgroundImage = ''; delete t.dataset.url;
    t.firstElementChild.style.display = '';
  }
}

/* ---------- Foto ---------- */
function takePhoto() {
  if (!canvas.width) return;
  render();
  $('flash').classList.remove('on'); void $('flash').offsetWidth; $('flash').classList.add('on');
  canvas.toBlob((blob) => blob && saveCapture(blob, 'jpg'), 'image/jpeg', 0.95);
}

/* ---------- Video ---------- */
const MIMES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
function startRecording() {
  if (!window.MediaRecorder || !canvas.captureStream) return toast('Este navegador no permite grabar video.');
  const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const out = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...state.stream.getAudioTracks()]);
  let rec;
  try { rec = new MediaRecorder(out, { mimeType: mime || undefined, videoBitsPerSecond: 8e6 }); }
  catch (e) { return toast('No se pudo iniciar la grabación.'); }
  state.chunks = [];
  rec.ondataavailable = (e) => e.data.size && state.chunks.push(e.data);
  rec.onstop = () => {
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const blob = new Blob(state.chunks, { type });
    state.chunks = [];
    if (blob.size) saveCapture(blob, type.includes('mp4') ? 'mp4' : 'webm');
  };
  rec.start(1000);
  state.recorder = rec; state.recStart = Date.now();
  $('shutter').classList.add('recording');
  $('shutter').setAttribute('aria-label', 'Detener grabación');
  $('flip').disabled = true; $('mPhoto').disabled = true;
  statusEl.classList.add('rec');
  const tick = () => {
    const s = Math.floor((Date.now() - state.recStart) / 1000);
    statusEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick(); state.recTimer = setInterval(tick, 500);
}
function stopRecording() {
  if (!state.recorder) return;
  clearInterval(state.recTimer);
  state.recorder.stop(); state.recorder = null;
  $('shutter').classList.remove('recording');
  $('shutter').setAttribute('aria-label', 'Grabar video');
  $('flip').disabled = false; $('mPhoto').disabled = false;
  updateStatus();
}

/* ---------- Galería ---------- */
let current = null, urls = [];
function openGallery() {
  urls.forEach(URL.revokeObjectURL); urls = [];
  const grid = $('grid'); grid.textContent = '';
  $('empty').hidden = items.length > 0;
  for (const item of items) {
    const url = URL.createObjectURL(item.blob); urls.push(url);
    const b = document.createElement('button');
    b.setAttribute('aria-label', item.name);
    if (item.type.startsWith('image/')) {
      const img = new Image(); img.src = url; img.alt = ''; b.append(img);
    } else {
      const v = document.createElement('video');
      v.src = url + '#t=0.1'; v.muted = true; v.playsInline = true; v.preload = 'metadata';
      b.append(v);
      b.insertAdjacentHTML('beforeend', '<svg class="play" viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>');
    }
    b.onclick = () => openViewer(item, url);
    grid.append(b);
  }
  $('gallery').hidden = false;
}
function openViewer(item, url) {
  current = item;
  $('vName').textContent = item.type.startsWith('image/') ? 'Foto' : 'Video';
  const stage = $('stage'); stage.textContent = '';
  let el;
  if (item.type.startsWith('image/')) { el = new Image(); el.alt = item.name; }
  else { el = document.createElement('video'); el.controls = true; el.playsInline = true; }
  el.src = url; stage.append(el);
  const file = new File([item.blob], item.name, { type: item.type });
  $('vShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('vDel').textContent = 'Borrar';
  $('viewer').hidden = false;
}
function closeViewer() { $('stage').textContent = ''; $('viewer').hidden = true; current = null; }

/* ---------- Eventos ---------- */
function setMode(mode) {
  if (state.recorder) return;
  state.mode = mode;
  $('mPhoto').setAttribute('aria-pressed', mode === 'photo');
  $('mVideo').setAttribute('aria-pressed', mode === 'video');
  $('shutter').classList.toggle('video', mode === 'video');
  $('shutter').setAttribute('aria-label', mode === 'photo' ? 'Tomar foto' : 'Grabar video');
}
$('mPhoto').onclick = () => setMode('photo');
$('mVideo').onclick = () => setMode('video');
$('shutter').onclick = () => {
  if (!state.stream) return;
  if (state.mode === 'photo') takePhoto();
  else if (state.recorder) stopRecording();
  else startRecording();
};
$('auto').onclick = () => {
  state.auto = !state.auto;
  $('auto').setAttribute('aria-pressed', state.auto);
};
$('gain').oninput = (e) => {
  state.auto = false; $('auto').setAttribute('aria-pressed', 'false');
  state.gain = +e.target.value; updateStatus();
};
$('green').onclick = () => {
  state.green = !state.green;
  $('green').setAttribute('aria-pressed', state.green);
};
$('torch').onclick = async () => {
  const track = state.stream && state.stream.getVideoTracks()[0];
  if (!track) return;
  const on = $('torch').getAttribute('aria-pressed') !== 'true';
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    $('torch').setAttribute('aria-pressed', on);
  } catch (e) { toast('La linterna no está disponible en esta cámara.'); }
};
$('flip').onclick = () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  startCamera();
};
$('thumb').onclick = openGallery;
$('gClose').onclick = () => { $('gallery').hidden = true; };
$('vClose').onclick = closeViewer;
$('vSave').onclick = () => { if (current) { download(current); toast('Descargado en tu celular.'); } };
$('vShare').onclick = async () => {
  if (!current) return;
  try { await navigator.share({ files: [new File([current.blob], current.name, { type: current.type })] }); } catch (e) { /* cancelado */ }
};
$('vDel').onclick = async () => {
  if (!current) return;
  if ($('vDel').textContent === 'Borrar') { $('vDel').textContent = '¿Seguro?'; return; }
  const id = current.id;
  items = items.filter((i) => i.id !== id);
  try { await store('readwrite', (s) => s.delete(id)); } catch (e) { /* sin IndexedDB */ }
  closeViewer(); setThumb(); openGallery();
};
$('retry').onclick = startCamera;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (state.recorder) stopRecording(); }
  else if (state.stream && navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
});

/* ---------- Arranque ---------- */
initGL();
loop();
setInterval(measure, 400);
startCamera();
store('readonly', (s) => s.getAll()).then((all) => {
  const have = new Set(items.map((i) => i.id));
  items = items.concat((all || []).filter((i) => !have.has(i.id))).sort((a, b) => b.id - a.id);
  setThumb();
}).catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
