const $ = (selector) => document.querySelector(selector);
const tabs = [...document.querySelectorAll('.tab')];
const audioFile = $('#audioFile');
const audioPlayer = $('#audioPlayer');
let audioContext;
let audioBuffer;
let currentAudioBlob;
let currentAudioUrl;
let currentProjectId;
let savedModel = null;
let annotations = [];
let customLabels = [];
let selectedRange = null;
let dragAnchor = null;
let activeClipEnd = null;
let mediaRecorder;
let recordedChunks = [];
let recordingStream;
let recognition;
let finalTranscript = '';
let speechRecognitionActive = false;
let recognitionBaseTranscript = '';

const examples = [
  '我：你刚才答应我今天早点回来，怎么又这么晚？\n对方：我临时有个会要开，不是故意不回你的。\n我：我知道你忙，可是等不到消息的时候我会很担心。\n对方：对不起，我应该早点告诉你。下次我有变化就给你发消息。',
  '我：最近家里的事情好像都是我在安排，我有点累。\n对方：我没意识到你觉得这么辛苦。你希望我具体做些什么？\n我：能不能这周你来负责接孩子和买菜？\n对方：可以，我们一起列个清单，我来处理。'
];

function setStatus(message = '') { $('#statusMessage').textContent = message; }
function setTab(name) { tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name)); document.querySelectorAll('.tab-content').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`)); }
tabs.forEach(tab => tab.addEventListener('click', () => setTab(tab.dataset.tab)));

$('#transcript').addEventListener('input', () => { $('#charCount').textContent = `${$('#transcript').value.length} 字`; setStatus(); });
$('#loadExample').addEventListener('click', () => { const next = examples[Math.floor(Math.random() * examples.length)]; $('#transcript').value = next; $('#charCount').textContent = `${next.length} 字`; setTab('text'); setStatus('已填入示例。你可以修改后生成洞察。'); });

function formatDuration(seconds) { if (!Number.isFinite(seconds)) return '—'; const m = Math.floor(seconds / 60); const s = Math.round(seconds % 60); return `${m}:${String(s).padStart(2, '0')}`; }
function showWaveform(values = null) {
  const host = $('#waveform'); host.innerHTML = '';
  if (!values?.length) { host.innerHTML = '<span class="wave-placeholder">添加录音或音频后显示波形</span>'; return; }
  const bars = 52;
  for (let i = 0; i < bars; i++) { const bar = document.createElement('i'); bar.className = 'waveform-bar'; const value = values[Math.floor(i * values.length / bars)] ?? .2; bar.style.height = `${Math.max(5, Math.min(50, value * 92))}px`; host.append(bar); }
  drawWaveformOverlays();
}
function estimateSignal(buffer) {
  if (!buffer) return null;
  const data = buffer.getChannelData(0); const sampleRate = buffer.sampleRate; const duration = buffer.duration;
  const frameSize = 2048; const hop = 4096; const rmsFrames = []; const pitchFrames = [];
  for (let start = 0; start + frameSize < data.length; start += hop) {
    let sum = 0; for (let i = 0; i < frameSize; i++) sum += data[start + i] * data[start + i];
    const rms = Math.sqrt(sum / frameSize); rmsFrames.push(rms);
    if (rms < .008) continue;
    let crossings = 0; for (let i = start + 1; i < start + frameSize; i++) if ((data[i - 1] <= 0 && data[i] > 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++;
    const rough = crossings * sampleRate / (2 * frameSize);
    if (rough > 65 && rough < 420) pitchFrames.push(rough);
  }
  const active = rmsFrames.filter(v => v > .004); const avg = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
  const sortedPitch = pitchFrames.sort((a, b) => a - b); const pitch = sortedPitch.length ? sortedPitch[Math.floor(sortedPitch.length / 2)] : 0;
  const range = sortedPitch.length > 4 ? sortedPitch[Math.floor(sortedPitch.length * .85)] - sortedPitch[Math.floor(sortedPitch.length * .15)] : 0;
  const values = rmsFrames.map(v => Math.min(1, v * 5));
  $('#durationStat').textContent = formatDuration(duration);
  $('#volumeStat').textContent = avg > .13 ? '偏强' : avg > .045 ? '适中' : avg > 0 ? '偏轻' : '—';
  $('#pitchStat').textContent = range > 75 ? '起伏较大' : range > 0 ? '相对平稳' : '不明显';
  $('#signalNote').innerHTML = '<span>i</span> 音量与音高通过简化信号特征估算；它们不能单独判断情绪。';
  showWaveform(values);
  return { duration, avg, pitchRange: range, volume: avg > .13 ? 'strong' : avg > .045 ? 'medium' : 'soft', pitch: range > 75 ? 'variable' : 'steady' };
}
async function decodeAudio(file) {
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  const bytes = await file.arrayBuffer();
  return audioContext.decodeAudioData(bytes.slice(0));
}
function installAudio(file, buffer, blobUrl, preserveAnnotations = false, projectId = null) {
  if (currentAudioUrl && currentAudioUrl !== blobUrl) URL.revokeObjectURL(currentAudioUrl);
  audioPlayer.pause(); audioBuffer = buffer; currentAudioBlob = file; currentAudioUrl = blobUrl;
  if (!preserveAnnotations) { annotations = []; currentProjectId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`; }
  else currentProjectId = projectId || currentProjectId || crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  selectedRange = null;
  $('#dropzone').classList.add('hidden'); $('#audioFileRow').classList.remove('hidden'); $('#audioPlayerWrap').classList.remove('hidden');
  $('#fileName').textContent = file.name || '录音'; $('#fileDetails').textContent = `${formatDuration(buffer.duration)} · 已在本地读取`;
  audioPlayer.src = blobUrl; estimateSignal(buffer); renderAnnotations(); updateSelectionUI(); setTab('upload'); setStatus('音频已就绪。拖动右侧波形创建情绪标注。'); persistWorkspace(); refreshProjectLibrary(); updateTrainingSummary();
}
audioFile.addEventListener('change', async () => {
  const file = audioFile.files?.[0]; if (!file) return;
  setStatus('正在读取音频…');
  try { const buffer = await decodeAudio(file); installAudio(file, buffer, URL.createObjectURL(file)); }
  catch (error) { setStatus('无法读取此音频格式，请尝试 WAV、MP3、M4A 或 OGG。'); }
});
$('#removeAudio').addEventListener('click', () => { audioPlayer.pause(); if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; audioPlayer.removeAttribute('src'); audioFile.value = ''; audioBuffer = null; currentAudioBlob = null; const oldProjectId = currentProjectId; currentProjectId = null; annotations = []; selectedRange = null; $('#audioPlayerWrap').classList.add('hidden'); $('#audioFileRow').classList.add('hidden'); $('#dropzone').classList.remove('hidden'); $('#durationStat').textContent = $('#volumeStat').textContent = $('#pitchStat').textContent = '—'; $('#signalNote').innerHTML = '<span>i</span> 拖动波形上的区间即可截取；音频与标注保存在此浏览器。'; showWaveform(); updateSelectionUI(); renderAnnotations(); if (oldProjectId) deleteProject(oldProjectId); setStatus(''); });
const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.style.borderColor = '#83a68b'; }));
['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.style.borderColor = ''; }));
dropzone.addEventListener('drop', e => { const file = e.dataTransfer.files?.[0]; if (!file) return; const transfer = new DataTransfer(); transfer.items.add(file); audioFile.files = transfer.files; audioFile.dispatchEvent(new Event('change')); });

function startRecognition() {
  const API = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!API) { $('#liveTranscript').textContent = '此浏览器不支持实时语音转写。录音仍会保存，请在「对话文本」中补充内容。'; return; }
  recognition = new API(); recognition.lang = 'zh-CN'; recognition.continuous = true; recognition.interimResults = true; finalTranscript = ''; recognitionBaseTranscript = $('#transcript').value.trim();
  recognition.onresult = (event) => { let interim = ''; for (let i = event.resultIndex; i < event.results.length; i++) { const phrase = event.results[i][0].transcript; if (event.results[i].isFinal) finalTranscript += phrase; else interim += phrase; }
    const display = finalTranscript + interim; $('#liveTranscript').textContent = display || '正在聆听…'; if (display.trim()) { const line = `我：${display}`; $('#transcript').value = recognitionBaseTranscript ? `${recognitionBaseTranscript}\n${line}` : line; $('#charCount').textContent = `${$('#transcript').value.length} 字`; }
  };
  recognition.onerror = () => { speechRecognitionActive = false; $('#liveTranscript').textContent = '语音转写暂不可用。录音会继续，你也可以手动输入对话。'; };
  try { recognition.start(); speechRecognitionActive = true; } catch (_) {}
}
async function beginRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setStatus('当前浏览器无法录音。请使用 HTTPS 或 localhost 打开页面，并检查麦克风权限。'); return; }
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true }); recordedChunks = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    mediaRecorder = new MediaRecorder(recordingStream, mime ? { mimeType: mime } : undefined);
    mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      try { const buffer = await decodeAudio(blob); const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'; installAudio(new File([blob], `录音.${ext}`, { type: blob.type }), buffer, URL.createObjectURL(blob)); }
      catch (_) { setStatus('录音已结束，但当前浏览器无法解码此格式。可以直接使用已转写的文本分析。'); }
      recordingStream?.getTracks().forEach(track => track.stop()); recordingStream = null;
    };
    mediaRecorder.start(); startRecognition();
    $('#recordTitle').textContent = '正在录音…'; $('#recordHint').textContent = '结束后，录音会保存在此页面并自动计算声音特征。'; $('#recordOrb').classList.add('recording');
    $('#recordButton').classList.add('is-recording'); $('#recordButton').innerHTML = '<span class="record-dot"></span><span>结束录音</span>'; setStatus('');
  } catch (error) { setStatus(error.name === 'NotAllowedError' ? '麦克风权限未开启，请在浏览器设置中允许访问。' : '无法开始录音，请检查麦克风是否可用。'); }
}
function stopRecording() {
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  if (speechRecognitionActive) { try { recognition.stop(); } catch (_) {} speechRecognitionActive = false; }
  $('#recordTitle').textContent = '录音已结束'; $('#recordHint').textContent = '你可以继续补充转写文本，或直接分析声音特征。'; $('#recordOrb').classList.remove('recording'); $('#recordButton').classList.remove('is-recording'); $('#recordButton').innerHTML = '<span class="record-dot"></span><span>重新录音</span>';
}
$('#recordButton').addEventListener('click', () => mediaRecorder?.state === 'recording' ? stopRecording() : beginRecording());

const lexicon = {
  焦虑: ['担心','害怕','不安','紧张','心慌','焦虑','等不到','没消息'],
  生气: ['生气','愤怒','受够','烦死','怎么又','每次都','从来不','总是这样','凭什么'],
  委屈: ['委屈','难过','失望','没人理解','我一个人','不公平','有点累','我很累'],
  温和: ['谢谢','辛苦','理解','我知道','没关系','抱歉','对不起','可以吗','一起'],
  积极: ['开心','高兴','太好了','喜欢','期待','愿意','可以','好呀','没问题'],
  防御: ['不是故意','别怪我','我没错','你也','我很忙','别说了','随便你'],
  需要: ['希望','需要','能不能','可不可以','我想要','能否','请你']
};
function parseTurns(text) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean); const found = [];
  for (const line of lines) {
    const match = line.match(/^([^：:]{1,12})[：:、]\s*(.+)$/);
    if (match) found.push({ speaker: match[1], text: match[2] }); else found.push({ speaker: found.length ? '对方' : '我', text: line });
  }
  return found;
}
function countHits(text, words) { return words.reduce((n, word) => n + (text.includes(word) ? 1 : 0), 0); }
function analyze(text, signal) {
  const turns = parseTurns(text); const all = turns.map(t => t.text).join('');
  const metrics = Object.entries(lexicon).map(([name, words]) => ({ name, score: countHits(all, words), words }));
  const wordCount = Math.max(1, Array.from(all).length);
  const audioBoost = signal ? (signal.volume === 'strong' ? 1 : 0) + (signal.pitch === 'variable' ? 1 : 0) : 0;
  const anger = metrics.find(x => x.name === '生气'); const anxious = metrics.find(x => x.name === '焦虑'); const sad = metrics.find(x => x.name === '委屈'); const warm = metrics.find(x => x.name === '温和'); const positive = metrics.find(x => x.name === '积极'); const defensive = metrics.find(x => x.name === '防御'); const needs = metrics.find(x => x.name === '需要');
  const emotions = [
    { name: '紧张 / 焦虑', value: Math.min(90, anxious.score * 22 + (signal?.volume === 'soft' ? 8 : 0)) },
    { name: '烦躁 / 生气', value: Math.min(90, anger.score * 21 + (signal?.volume === 'strong' && signal?.pitch === 'variable' ? 12 : 0)) },
    { name: '委屈 / 失落', value: Math.min(90, sad.score * 23) },
    { name: '温和 / 关心', value: Math.min(90, warm.score * 17) },
    { name: '积极 / 合作', value: Math.min(90, positive.score * 18) }
  ].sort((a, b) => b.value - a.value).filter(x => x.value > 0).slice(0, 3);
  if (!emotions.length) emotions.push({ name: '平静 / 待观察', value: signal?.volume === 'strong' ? 39 : 22 }, { name: '关切 / 待确认', value: 16 });
  const tense = anger.score + anxious.score + sad.score + (signal?.volume === 'strong' ? 1 : 0);
  const care = warm.score + positive.score;
  let title, summary;
  if (tense > care + 2) { title = '情绪有些紧绷，需要先被听见'; summary = '对话里出现了不安、失望或不满的表达线索。先回应具体感受和在意的事情，再讨论怎么解决，通常更容易继续沟通。'; }
  else if (care > tense + 1) { title = '整体较愿意靠近，仍有合作空间'; summary = '对话中能看到关心、道歉或一起解决问题的表达。把可执行的小约定说清楚，有助于把善意变成持续的行动。'; }
  else { title = '整体偏平和，双方仍在摸索彼此'; summary = '当前表达里的情绪信号不算强烈。可以更具体地说出各自的感受、期待和下一步，避免只讨论谁对谁错。'; }
  const speakers = [...new Set(turns.map(t => t.speaker))]; const firstSpeaker = speakers[0] || '我'; const secondSpeaker = speakers.find(s => s !== firstSpeaker) || '对方';
  const asks = turns.filter(t => countHits(t.text, lexicon.需要) > 0).length;
  const apology = turns.filter(t => /对不起|抱歉|我理解|你说得对/.test(t.text)).length;
  const dismiss = turns.filter(t => /别说了|随便你|你想多了|这有什么/.test(t.text)).length;
  const responds = turns.length >= 3 && (apology > 0 || turns.some(t => /可以|我会|下次|我来/.test(t.text)));
  let relationTitle = '从表达需要开始观察回应'; let relationText = '目前能看到表达和回应，但仅凭这段内容无法确定关系模式。留意需求是否被听到、回应是否具体，以及后续行动能否兑现。'; let mapClass = '';
  if (dismiss > 0) { relationTitle = '有一处回应可能让感受落空'; relationText = '出现了快速否定或结束话题的表达。可以试着先确认对方的感受，再讨论事实和分工。'; mapClass = 'distant'; }
  else if (asks > 0 && responds) { relationTitle = '表达需要后出现了回应'; relationText = '对话里能看到具体请求和一定的回应、道歉或行动意愿。这是继续协商的起点，之后可以约定具体时间和做法。'; mapClass = 'connected'; }
  else if (asks === 0) { relationTitle = '感受或请求还可以说得更具体'; relationText = '对话中较少出现明确请求。把“你总是……”换成一个具体情境、个人感受和可执行的请求，能减少猜测。'; mapClass = 'unclear'; }
  const advice = [];
  if (anger.score || anxious.score || sad.score || signal?.volume === 'strong') advice.push('“我想先说说这件事让我有什么感受，也想听听你当时是怎么想的。”');
  if (asks === 0 || needs.score === 0) advice.push('把指责换成具体请求：“下次如果会晚回，能不能提前发我一条消息？”');
  if (dismiss || defensive.score) advice.push('先确认彼此理解的是同一件事，再商量下一步；如果情绪很满，可以约一个稍后继续聊的时间。');
  if (!advice.length) advice.push('把已经达成的共识整理成一个小行动，并约好什么时候再确认进展。');
  if (turns.length <= 1) advice.push('如果是双人关系分析，请用不同说话人标记各自的发言，这样更容易观察互动。');
  return { title, summary, emotions, relationTitle, relationText, advice: advice.slice(0, 3), speakers: [firstSpeaker, secondSpeaker], mapClass, turnCount: turns.length };
}
function renderResult(result) {
  $('#emptyState').classList.add('hidden'); $('#resultContent').classList.remove('hidden');
  $('#overallTitle').textContent = result.title; $('#overallSummary').textContent = result.summary;
  const list = $('#emotionList'); list.innerHTML = '';
  result.emotions.forEach(e => { const row = document.createElement('div'); row.className = 'emotion-row'; row.innerHTML = `<span class="emotion-label"></span><div class="emotion-track"><div class="emotion-fill"></div></div><span class="emotion-score"></span>`; row.querySelector('.emotion-label').textContent = e.name; row.querySelector('.emotion-fill').style.width = `${Math.max(e.value, 10)}%`; row.querySelector('.emotion-score').textContent = `${e.value}%`; list.append(row); });
  $('#relationshipTitle').textContent = result.relationTitle; $('#relationshipText').textContent = result.relationText; $('#relationshipVisual').className = `relationship-visual ${result.mapClass}`; $('#relationshipVisual').querySelectorAll('span')[0].textContent = result.speakers[0]; $('#relationshipVisual').querySelectorAll('span')[1].textContent = result.speakers[1];
  const adviceList = $('#adviceList'); adviceList.innerHTML = ''; result.advice.forEach(text => { const item = document.createElement('div'); item.className = 'advice-item'; item.textContent = text; adviceList.append(item); });
}
$('#analyzeButton').addEventListener('click', () => {
  const transcript = $('#transcript').value.trim(); const signal = audioBuffer ? estimateSignal(audioBuffer) : null;
  if (!transcript && !signal) { setStatus('请先录制或上传音频，或添加一段对话文本。'); return; }
  if (!transcript && signal) { const result = analyze('', signal); result.title = '已读到声音线索，补充文本后可继续分析'; result.summary = '当前只分析了音量和音高变化，无法从声音特征单独判断说话内容、具体情绪或人物关系。请在「对话文本」中粘贴转写内容，让互动分析更有依据。'; result.relationTitle = '需要对话内容才能观察关系互动'; result.relationText = '语音信号不能说明谁说了什么，也无法判断双方如何回应。补充带有说话人标记的文本后，可继续查看互动线索。'; result.advice = ['可以先转写这段对话，并标注每句话是谁说的。']; renderResult(result); setStatus(''); $('#resultsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const result = analyze(transcript, signal); renderResult(result); setStatus(''); $('#resultsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#clearResults').addEventListener('click', () => { $('#resultContent').classList.add('hidden'); $('#emptyState').classList.remove('hidden'); setStatus(''); });

document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', e => { e.preventDefault(); const target = item.getAttribute('href'); document.querySelector(target)?.scrollIntoView({ behavior: 'smooth' }); document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active')); item.classList.add('active'); }));

const emotionNames = { neutral: '平静', happy: '开心', sad: '难过', angry: '愤怒', anxious: '焦虑', calm: '平和', disgust: '厌恶', fear: '害怕', other: '其他' };
const builtInDefinitions = { neutral: '语气相对平稳，情绪表达不明显。', happy: '听起来愉悦、兴奋或开心。', sad: '听起来低落、难过或失望。', angry: '听起来生气、恼火或有明显对抗感。', anxious: '听起来担心、紧张或不安。', calm: '听起来放松、柔和或安定。', disgust: '听起来有厌恶、排斥或嫌弃感。', fear: '听起来害怕、受惊或感到威胁。', other: '无法归入其他类别，或多种情绪难以区分。' };
const speakerNames = { speaker_1: '说话人 A', speaker_2: '说话人 B', unknown: '未知' };
const waveform = $('#waveform');

function loadCustomLabels() {
  try { const saved = JSON.parse(localStorage.getItem('shengyu-emotion-labels') || '[]'); if (Array.isArray(saved)) customLabels = saved.filter(label => label && typeof label.code === 'string' && typeof label.name === 'string'); } catch (_) {}
  customLabels.forEach(label => { emotionNames[label.code] = label.name; }); renderEmotionOptions(); renderCustomLabels();
}
function renderEmotionOptions() {
  const select = $('#emotionLabel'); const selected = select.value; select.replaceChildren();
  Object.entries(emotionNames).forEach(([code, name]) => { const option = document.createElement('option'); option.value = code; option.textContent = `${name} ${code}`; select.append(option); });
  if (Object.hasOwn(emotionNames, selected)) select.value = selected;
}
function renderCustomLabels() {
  const builtins = $('#builtInEmotionList');
  if (builtins) {
    builtins.innerHTML = '';
    Object.entries(builtInDefinitions).forEach(([code, definition]) => { const row = document.createElement('div'); row.className = 'custom-emotion'; const title = document.createElement('strong'); title.textContent = `${emotionNames[code]} · ${code}`; const detail = document.createElement('span'); detail.textContent = definition; row.append(title, detail); builtins.append(row); });
  }
  const host = $('#customEmotionList'); if (!host) return; host.innerHTML = '';
  customLabels.forEach(label => {
    const row = document.createElement('div'); row.className = 'custom-emotion'; const title = document.createElement('strong'); title.textContent = `${label.name} · ${label.code}`; const definition = document.createElement('span'); definition.textContent = label.definition || '未填写定义'; const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除'; remove.title = '删除此自定义标签';
    remove.addEventListener('click', async () => { const projects = await getAllStoredProjects().catch(() => []); if (projects.some(project => project.annotations?.some(item => item.emotion === label.code))) { setStatus('本地录音库中仍有片段使用此标签，请先重新标注这些片段。'); return; } customLabels = customLabels.filter(item => item.code !== label.code); delete emotionNames[label.code]; try { localStorage.setItem('shengyu-emotion-labels', JSON.stringify(customLabels)); } catch (_) {} renderEmotionOptions(); renderCustomLabels(); persistWorkspace(); });
    row.append(title, definition, remove); host.append(row);
  });
}
$('#addCustomEmotion').addEventListener('click', () => {
  const code = $('#customEmotionCode').value.trim().toLowerCase(); const name = $('#customEmotionName').value.trim(); const definition = $('#customEmotionDefinition').value.trim();
  if (!/^[a-z][a-z0-9_-]{1,23}$/.test(code)) { setStatus('标签代码请用 2–24 位小写英文、数字、短横线或下划线，且以字母开头。'); return; }
  if (!name || !definition) { setStatus('请填写中文标签名和明确的标注定义。'); return; }
  if (Object.hasOwn(emotionNames, code)) { setStatus('这个标签代码已存在，请换一个。'); return; }
  const label = { code, name, definition }; customLabels.push(label); emotionNames[code] = name; try { localStorage.setItem('shengyu-emotion-labels', JSON.stringify(customLabels)); } catch (_) {} renderEmotionOptions(); renderCustomLabels(); $('#emotionLabel').value = code; $('#customEmotionCode').value = $('#customEmotionName').value = $('#customEmotionDefinition').value = ''; persistWorkspace(); setStatus('自定义情绪标准已保存。');
});
loadCustomLabels();

function drawWaveformOverlays() {
  waveform.querySelectorAll('.saved-segment-marker,.wave-selection').forEach(node => node.remove());
  if (!audioBuffer) return;
  annotations.forEach(item => {
    const marker = document.createElement('i'); marker.className = 'saved-segment-marker';
    marker.style.left = `${item.start / audioBuffer.duration * 100}%`; marker.style.width = `${(item.end - item.start) / audioBuffer.duration * 100}%`; marker.title = `${emotionNames[item.emotion]} ${formatDuration(item.start)}–${formatDuration(item.end)}`; waveform.append(marker);
  });
  if (selectedRange) {
    const selection = document.createElement('i'); selection.className = 'wave-selection';
    selection.style.left = `${selectedRange.start / audioBuffer.duration * 100}%`; selection.style.width = `${(selectedRange.end - selectedRange.start) / audioBuffer.duration * 100}%`; waveform.append(selection);
  }
}
function rangeAtPointer(event) {
  const bounds = waveform.getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  return ratio * (audioBuffer?.duration || 0);
}
function updateSelectionUI() {
  const range = selectedRange;
  $('#selectionRange').textContent = range ? `${range.start.toFixed(2)}s – ${range.end.toFixed(2)}s  ·  ${(range.end - range.start).toFixed(2)} 秒` : '—';
  $('#playSelection').disabled = !range; $('#addSegment').disabled = !range || !audioBuffer;
  $('#predictSelection').disabled = !savedModel || !range || !audioBuffer;
  $('#segmentHint').textContent = range ? '检查区间后选择情绪与说话人，再保存标注。' : audioBuffer ? '拖动波形上的区间；最短片段为 0.25 秒。' : '先载入音频，再在波形上拖出一段区间。';
  drawWaveformOverlays();
}
waveform.addEventListener('pointerdown', event => {
  if (!audioBuffer) return;
  event.preventDefault(); dragAnchor = rangeAtPointer(event); selectedRange = { start: dragAnchor, end: dragAnchor };
  waveform.setPointerCapture(event.pointerId); updateSelectionUI();
});
waveform.addEventListener('pointermove', event => {
  if (dragAnchor === null || !audioBuffer) return;
  const current = rangeAtPointer(event); selectedRange = { start: Math.min(dragAnchor, current), end: Math.max(dragAnchor, current) }; updateSelectionUI();
});
function finishWaveDrag(event) {
  if (dragAnchor === null) return;
  if (audioBuffer) {
    const current = rangeAtPointer(event); selectedRange = { start: Math.min(dragAnchor, current), end: Math.max(dragAnchor, current) };
    if (selectedRange.end - selectedRange.start < .25) selectedRange = null;
  }
  dragAnchor = null; updateSelectionUI();
}
waveform.addEventListener('pointerup', finishWaveDrag); waveform.addEventListener('pointercancel', finishWaveDrag);

function playClip(start, end) {
  if (!audioBuffer) return;
  activeClipEnd = end; audioPlayer.currentTime = start;
  audioPlayer.play().catch(() => setStatus('无法播放这段音频，请先点击音频播放器的播放按钮。'));
}
audioPlayer.addEventListener('timeupdate', () => { if (activeClipEnd !== null && audioPlayer.currentTime >= activeClipEnd) { audioPlayer.pause(); activeClipEnd = null; } });
audioPlayer.addEventListener('ended', () => { activeClipEnd = null; });
$('#playSelection').addEventListener('click', () => { if (selectedRange) playClip(selectedRange.start, selectedRange.end); });

function renderAnnotations() {
  const host = $('#segmentList'); host.innerHTML = ''; $('#segmentCount').textContent = String(annotations.length);
  $('#exportDataset').disabled = annotations.length === 0 || !audioBuffer;
  if (!annotations.length) { host.innerHTML = '<div class="segment-empty">添加标签后，片段会显示在这里。</div>'; drawWaveformOverlays(); return; }
  annotations.forEach(item => {
    const row = document.createElement('div'); row.className = 'segment-item';
    const top = document.createElement('div'); top.className = 'segment-item-top';
    const time = document.createElement('span'); time.className = 'segment-time'; time.textContent = `${formatDuration(item.start)}–${formatDuration(item.end)}`;
    const chip = document.createElement('span'); chip.className = 'emotion-chip'; chip.dataset.emotion = item.emotion; chip.textContent = `${emotionNames[item.emotion]} · ${item.emotion}`;
    top.append(time, chip);
    const meta = document.createElement('div'); meta.className = 'segment-meta'; meta.textContent = `${speakerNames[item.speaker] || item.speaker} · ${({high:'确定',medium:'一般',low:'不确定'})[item.confidence] || '一般'}`;
    const actions = document.createElement('div'); actions.className = 'segment-actions';
    const play = document.createElement('button'); play.type = 'button'; play.textContent = '▶'; play.title = '试听片段'; play.addEventListener('click', () => playClip(item.start, item.end));
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = '删除标注'; remove.addEventListener('click', () => { annotations = annotations.filter(a => a.id !== item.id); renderAnnotations(); persistWorkspace(); });
    actions.append(play, remove); row.append(top, meta, actions);
    if (item.note) { const note = document.createElement('div'); note.className = 'segment-note'; note.textContent = item.note; row.append(note); }
    host.append(row);
  });
  drawWaveformOverlays();
}
$('#addSegment').addEventListener('click', () => {
  if (!selectedRange || !audioBuffer) return;
  annotations.push({ id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, start: Number(selectedRange.start.toFixed(3)), end: Number(selectedRange.end.toFixed(3)), emotion: $('#emotionLabel').value, speaker: $('#speakerLabel').value, confidence: $('#confidenceLabel').value, note: $('#segmentNote').value.trim() });
  annotations.sort((a, b) => a.start - b.start); $('#segmentNote').value = ''; selectedRange = null; renderAnnotations(); updateSelectionUI(); persistWorkspace(); setStatus('情绪标注已保存到本地。');
});

function pcmWav(buffer, startSeconds, endSeconds) {
  const rate = buffer.sampleRate; const first = Math.max(0, Math.floor(startSeconds * rate)); const last = Math.min(buffer.length, Math.floor(endSeconds * rate)); const frames = Math.max(1, last - first); const channels = buffer.numberOfChannels; const bytesPerSample = 2; const dataBytes = frames * channels * bytesPerSample;
  const bytes = new ArrayBuffer(44 + dataBytes); const view = new DataView(bytes);
  const writeText = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeText(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); writeText(8, 'WAVE'); writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true); view.setUint32(28, rate * channels * bytesPerSample, true); view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true); writeText(36, 'data'); view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) for (let channel = 0; channel < channels; channel++) { const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[first + i])); view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true); offset += 2; }
  return new Uint8Array(bytes);
}
const crcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const encoder = new TextEncoder(); const localParts = []; const centralParts = []; let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name); const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data); const crc = crc32(data);
    const local = new Uint8Array(30 + name.length); const lv = new DataView(local.buffer); lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 33, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30); localParts.push(local, data);
    const central = new Uint8Array(46 + name.length); const cv = new DataView(central.buffer); cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 33, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true); central.set(name, 46); centralParts.push(central); offset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0); const end = new Uint8Array(22); const ev = new DataView(end.buffer); ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
$('#exportDataset').addEventListener('click', async () => {
  if (!audioBuffer || !annotations.length) return;
  const files = []; const rows = [];
  annotations.forEach((item, index) => {
    const filename = `segments/${String(index + 1).padStart(4, '0')}_${item.emotion}_${item.speaker}.wav`;
    files.push({ name: filename, data: pcmWav(audioBuffer, item.start, item.end) });
    rows.push({ audio_file: filename, start_sec: item.start, end_sec: item.end, start_ms: Math.round(item.start * 1000), end_ms: Math.round(item.end * 1000), emotion: item.emotion, emotion_zh: emotionNames[item.emotion], speaker: item.speaker, confidence: item.confidence, note: item.note || '', sample_rate: audioBuffer.sampleRate, channels: audioBuffer.numberOfChannels });
  });
  const jsonl = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const columns = Object.keys(rows[0]); const csv = [columns.map(csvCell).join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n');
  const customDefinitions = Object.fromEntries(customLabels.map(label => [label.code, label.definition]));
  const dictionary = Object.fromEntries(Object.entries(emotionNames).map(([code, label]) => [code, { label_zh: label, definition: customDefinitions[code] || builtInDefinitions[code] || '' }]));
  files.push({ name: 'labels.jsonl', data: new TextEncoder().encode(jsonl) }, { name: 'labels.csv', data: new TextEncoder().encode(`\ufeff${csv}`) }, { name: 'label_dictionary.json', data: new TextEncoder().encode(JSON.stringify(dictionary, null, 2)) }, { name: 'README.txt', data: new TextEncoder().encode('声语情绪标注数据集\n每个 JSONL/CSV 行对应 segments/ 中的 WAV 片段。情绪代码是本项目的工作标签集，可按你的标注规范调整。confidence 是标注者把握程度，不是模型预测概率。请在训练前检查类别定义、样本平衡、说话人隔离与授权。\n') });
  $('#exportDataset').disabled = true; $('#exportDataset').textContent = '正在打包…';
  try { const archive = makeZip(files); const url = URL.createObjectURL(archive); const link = document.createElement('a'); link.href = url; link.download = 'shengyu-emotion-dataset.zip'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); setStatus(`已导出 ${rows.length} 条标注片段。`); }
  catch (error) { setStatus('打包失败，请减少片段数量后重试。'); }
  finally { $('#exportDataset').disabled = false; $('#exportDataset').textContent = '导出训练集 ↥'; }
});

function openWorkspaceDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('当前浏览器不支持本地数据保存。')); return; }
    const request = indexedDB.open('shengyu-annotation-workspace', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function persistWorkspace() {
  if (!currentAudioBlob) return;
  try {
    currentProjectId ||= crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const db = await openWorkspaceDb(); await new Promise((resolve, reject) => { const tx = db.transaction('projects', 'readwrite'); const store = tx.objectStore('projects'); store.put({ id: currentProjectId, audio: currentAudioBlob, name: currentAudioBlob.name || '录音', annotations, customLabels }, currentProjectId); store.put(currentProjectId, 'active'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    refreshProjectLibrary(); updateTrainingSummary();
  }
  catch (_) { $('#segmentHint').textContent = '浏览器本地存储不可用；请及时导出标注集以免刷新后丢失。'; }
}
async function getStoredProject(id) {
  const db = await openWorkspaceDb(); const value = await new Promise((resolve, reject) => { const request = db.transaction('projects', 'readonly').objectStore('projects').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); db.close(); return value;
}
async function getAllStoredProjects() {
  const db = await openWorkspaceDb(); const result = await new Promise((resolve, reject) => { const request = db.transaction('projects', 'readonly').objectStore('projects').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); db.close(); return result.filter(value => value?.audio && value?.id);
}
async function deleteProject(id) {
  try { const db = await openWorkspaceDb(); await new Promise((resolve, reject) => { const tx = db.transaction('projects', 'readwrite'); const store = tx.objectStore('projects'); store.delete(id); store.get('active').onsuccess = event => { if (event.target.result === id) store.delete('active'); }; tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close(); refreshProjectLibrary(); updateTrainingSummary(); } catch (_) {}
}
async function refreshProjectLibrary() {
  try {
    const projects = await getAllStoredProjects(); const select = $('#projectSelector'); const active = currentProjectId; select.replaceChildren();
    projects.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
    projects.forEach(project => { const option = document.createElement('option'); option.value = project.id; option.textContent = `${project.name || '录音'} · ${project.annotations?.length || 0} 段`; select.append(option); });
    select.disabled = !projects.length; $('#projectCount').textContent = `${projects.length} 段录音 · ${projects.reduce((sum, project) => sum + (project.annotations?.length || 0), 0)} 条标注`; if (active && projects.some(project => project.id === active)) select.value = active;
  } catch (_) { $('#projectCount').textContent = '本地录音库暂不可用'; }
}
$('#projectSelector').addEventListener('change', async event => {
  const id = event.target.value; if (!id || id === currentProjectId) return;
  try {
    const project = await getStoredProject(id); if (!project?.audio) return;
    audioPlayer.pause(); const file = new File([project.audio], project.name || '录音', { type: project.audio.type || 'audio/wav' }); const buffer = await decodeAudio(file);
    annotations = Array.isArray(project.annotations) ? project.annotations : []; installAudio(file, buffer, URL.createObjectURL(project.audio), true, id); setStatus(`已切换到「${project.name || '录音'}」。`);
  } catch (_) { setStatus('无法打开这段已保存录音。'); }
});
async function restoreWorkspace() {
  try {
    const pointer = await getStoredProject('active');
    let project = typeof pointer === 'string' ? await getStoredProject(pointer) : pointer;
    if (project?.audio && !project.id) { project.id = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`; currentProjectId = project.id; annotations = Array.isArray(project.annotations) ? project.annotations : []; await persistWorkspace(); }
    if (project?.audio) {
      const blob = project.audio; const name = project.name || '已保存音频'; const file = new File([blob], name, { type: blob.type || 'audio/wav' }); const buffer = await decodeAudio(file);
      annotations = Array.isArray(project.annotations) ? project.annotations : []; if (Array.isArray(project.customLabels)) { customLabels = project.customLabels; customLabels.forEach(label => { emotionNames[label.code] = label.name; }); try { localStorage.setItem('shengyu-emotion-labels', JSON.stringify(customLabels)); } catch (_) {} renderEmotionOptions(); renderCustomLabels(); } installAudio(file, buffer, URL.createObjectURL(blob), true, project.id); setStatus('已恢复上次的音频和本地标注。');
    }
    const model = await getStoredProject('model'); if (model?.weights) { savedModel = model; renderSavedModel(); }
    refreshProjectLibrary(); updateTrainingSummary();
  } catch (_) { $('#segmentHint').textContent = '无法恢复上次的工作区。请重新载入音频，或使用已导出的训练集。'; }
}
restoreWorkspace();

const FEATURE_RATE = 16000;
const FFT_SIZE = 512;
const FRAME_SIZE = 400;
const FRAME_HOP = 320;
const MEL_BANDS = 24;
const FEATURE_SIZE = MEL_BANDS * 2 + 4;
function melToHz(mel) { return 700 * (10 ** (mel / 2595) - 1); }
function buildMelBank() {
  const hzToMel = hz => 2595 * Math.log10(1 + hz / 700); const low = hzToMel(40); const high = hzToMel(FEATURE_RATE / 2);
  const points = Array.from({ length: MEL_BANDS + 2 }, (_, i) => melToHz(low + (high - low) * i / (MEL_BANDS + 1)));
  return Array.from({ length: MEL_BANDS }, (_, band) => {
    const weights = new Float32Array(FFT_SIZE / 2 + 1);
    for (let bin = 0; bin < weights.length; bin++) { const hz = bin * FEATURE_RATE / FFT_SIZE; const left = points[band]; const center = points[band + 1]; const right = points[band + 2]; weights[bin] = hz < left || hz > right ? 0 : hz <= center ? (hz - left) / Math.max(1, center - left) : (right - hz) / Math.max(1, right - center); }
    return weights;
  });
}
const melBank = buildMelBank();
function fftPower(frame) {
  const real = new Float64Array(FFT_SIZE); const imag = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) real[i] = frame[i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (FRAME_SIZE - 1)));
  for (let i = 1, j = 0; i < FFT_SIZE; i++) { let bit = FFT_SIZE >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; } }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) { const angle = -2 * Math.PI / size; const half = size >> 1; for (let start = 0; start < FFT_SIZE; start += size) for (let j = 0; j < half; j++) { const wr = Math.cos(angle * j); const wi = Math.sin(angle * j); const even = start + j; const odd = even + half; const tr = wr * real[odd] - wi * imag[odd]; const ti = wr * imag[odd] + wi * real[odd]; real[odd] = real[even] - tr; imag[odd] = imag[even] - ti; real[even] += tr; imag[even] += ti; } }
  return Array.from({ length: FFT_SIZE / 2 + 1 }, (_, i) => real[i] * real[i] + imag[i] * imag[i]);
}
function extractFeatures(buffer, startSeconds, endSeconds) {
  const sourceStart = Math.max(0, Math.floor(startSeconds * buffer.sampleRate)); const sourceEnd = Math.min(buffer.length, Math.ceil(endSeconds * buffer.sampleRate));
  const targetLength = Math.max(1, Math.floor((sourceEnd - sourceStart) * FEATURE_RATE / buffer.sampleRate)); const mono = new Float32Array(targetLength);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)); const ratio = buffer.sampleRate / FEATURE_RATE;
  for (let i = 0; i < targetLength; i++) { const position = sourceStart + i * ratio; const index = Math.min(buffer.length - 1, Math.floor(position)); const next = Math.min(buffer.length - 1, index + 1); const fraction = position - index; let sample = 0; for (const channel of channels) sample += channel[index] * (1 - fraction) + channel[next] * fraction; mono[i] = sample / channels.length; }
  const frames = [];
  for (let start = 0; start < mono.length; start += FRAME_HOP) {
    const frame = new Float32Array(FRAME_SIZE); let energy = 0; let crossings = 0;
    for (let i = 0; i < FRAME_SIZE; i++) { const value = mono[Math.min(mono.length - 1, start + i)] || 0; frame[i] = value; energy += value * value; if (i > 0 && (value >= 0) !== (frame[i - 1] >= 0)) crossings++; }
    const power = fftPower(frame); const features = melBank.map(weights => { let sum = 0; for (let bin = 0; bin < weights.length; bin++) sum += power[bin] * weights[bin]; return Math.log(1e-10 + sum); });
    features.push(Math.log(1e-8 + Math.sqrt(energy / FRAME_SIZE)), crossings / FRAME_SIZE); frames.push(features);
    if (start + FRAME_SIZE >= mono.length) break;
  }
  const means = Array(FEATURE_SIZE).fill(0); for (const frame of frames) for (let i = 0; i < FEATURE_SIZE; i++) means[i] += frame[i] / frames.length;
  const variances = Array(FEATURE_SIZE).fill(0); for (const frame of frames) for (let i = 0; i < FEATURE_SIZE; i++) variances[i] += (frame[i] - means[i]) ** 2 / frames.length;
  return [...means, ...variances.map(value => Math.sqrt(value + 1e-8))];
}
function softmax(logits) { const max = Math.max(...logits); const values = logits.map(value => Math.exp(value - max)); const total = values.reduce((a, b) => a + b, 0) || 1; return values.map(value => value / total); }
function prepareModelData(samples) {
  const featureSize = samples[0].features.length; const means = Array(featureSize).fill(0); const scales = Array(featureSize).fill(0);
  samples.forEach(sample => sample.features.forEach((value, i) => { means[i] += value / samples.length; }));
  samples.forEach(sample => sample.features.forEach((value, i) => { scales[i] += (value - means[i]) ** 2 / samples.length; }));
  const stds = scales.map(value => Math.sqrt(value) || 1); return { means, stds, xs: samples.map(sample => sample.features.map((value, i) => (value - means[i]) / stds[i])) };
}
function fitEmotionClassifier(samples, classes, epochs = 140) {
  const { means, stds, xs } = prepareModelData(samples); const weights = Array.from({ length: classes.length }, () => Array(FEATURE_SIZE).fill(0)); const biases = Array(classes.length).fill(0); const classIndex = new Map(classes.map((label, index) => [label, index])); const counts = Object.fromEntries(classes.map(label => [label, samples.filter(sample => sample.label === label).length])); const effectiveWeight = sample => sample.weight * samples.length / (classes.length * counts[sample.label]); const weightsTotal = samples.reduce((sum, sample) => sum + effectiveWeight(sample), 0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = weights.map(() => Array(FEATURE_SIZE).fill(0)); const gradB = Array(classes.length).fill(0);
    samples.forEach((sample, row) => { const logits = weights.map((vector, c) => biases[c] + vector.reduce((sum, value, i) => sum + value * xs[row][i], 0)); const probs = softmax(logits); const target = classIndex.get(sample.label); const rowWeight = effectiveWeight(sample); for (let c = 0; c < classes.length; c++) { const error = (probs[c] - (c === target ? 1 : 0)) * rowWeight; gradB[c] += error; for (let i = 0; i < FEATURE_SIZE; i++) gradW[c][i] += error * xs[row][i]; } });
    const rate = .13 * (1 - .5 * epoch / epochs); for (let c = 0; c < classes.length; c++) { biases[c] -= rate * gradB[c] / weightsTotal; for (let i = 0; i < FEATURE_SIZE; i++) weights[c][i] -= rate * (gradW[c][i] / weightsTotal + .001 * weights[c][i]); }
  }
  return { means, stds, weights, biases };
}
function modelProbabilities(model, features) { const standardized = features.map((value, i) => (value - model.means[i]) / (model.stds[i] || 1)); return softmax(model.weights.map((weights, c) => model.biases[c] + weights.reduce((sum, value, i) => sum + value * standardized[i], 0))); }
function splitForValidation(samples, classes) {
  const train = []; const validation = []; let canValidate = true; let seed = 5729;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (const label of classes) { const rows = samples.filter(sample => sample.label === label).slice(); if (rows.length < 5) { canValidate = false; break; } for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; } const count = Math.max(1, Math.floor(rows.length * .2)); validation.push(...rows.slice(0, count)); train.push(...rows.slice(count)); }
  return canValidate ? { train, validation } : null;
}
function evaluateClassifier(model, samples, classes) {
  let correct = 0; const stats = Object.fromEntries(classes.map(label => [label, { tp: 0, fp: 0, fn: 0 }]));
  samples.forEach(sample => { const probs = modelProbabilities(model, sample.features); const predicted = classes[probs.indexOf(Math.max(...probs))]; if (predicted === sample.label) correct++; for (const label of classes) { if (predicted === label && sample.label === label) stats[label].tp++; else if (predicted === label) stats[label].fp++; else if (sample.label === label) stats[label].fn++; } });
  const macroF1 = Object.values(stats).reduce((sum, row) => { const precision = row.tp / Math.max(1, row.tp + row.fp); const recall = row.tp / Math.max(1, row.tp + row.fn); return sum + (2 * precision * recall / Math.max(1e-9, precision + recall)); }, 0) / classes.length;
  return { accuracy: correct / samples.length, macroF1, validationSamples: samples.length };
}
async function collectTrainingSamples() {
  const projects = await getAllStoredProjects(); const samples = []; const total = projects.reduce((sum, project) => sum + (project.annotations?.length || 0), 0); let completed = 0;
  for (const project of projects) {
    if (!project.annotations?.length) continue;
    const file = new File([project.audio], project.name || '录音', { type: project.audio.type || 'audio/wav' }); const buffer = await decodeAudio(file);
    for (const item of project.annotations) { if (Object.hasOwn(emotionNames, item.emotion)) samples.push({ features: extractFeatures(buffer, item.start, item.end), label: item.emotion, weight: ({ high: 1, medium: .75, low: .5 })[item.confidence] || .75, projectId: project.id }); completed++; $('#modelStatus').textContent = `提取 Log-Mel 特征：${completed} / ${total} 段`; await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  return samples;
}
async function updateTrainingSummary() {
  try {
    const projects = await getAllStoredProjects(); const counts = {};
    projects.forEach(project => (project.annotations || []).forEach(item => { counts[item.emotion] = (counts[item.emotion] || 0) + 1; }));
    const classes = Object.keys(counts); const total = Object.values(counts).reduce((sum, value) => sum + value, 0); const host = $('#trainingCounts'); host.innerHTML = '';
    if (!total) { host.textContent = '当前还没有已标注片段。至少两种情绪、每类 2 段才可训练。'; $('#trainModel').disabled = true; }
    else {
      const summary = document.createElement('div'); summary.textContent = `${projects.length} 段录音 · ${total} 个训练样本 · ${classes.length} 类`; host.append(summary);
      const labels = document.createElement('div'); classes.forEach(code => { const tag = document.createElement('span'); tag.className = 'class-count'; tag.textContent = `${emotionNames[code] || code} ${counts[code]}`; labels.append(tag); }); host.append(labels);
      $('#trainModel').disabled = classes.length < 2 || Object.values(counts).some(count => count < 2);
    }
    $('#predictSelection').disabled = !savedModel || !selectedRange || !audioBuffer;
    if (savedModel) $('#modelStatus').textContent = `本地已保存模型 · ${savedModel.sampleCount} 个样本 · ${new Date(savedModel.createdAt).toLocaleString('zh-CN')}`;
  } catch (_) { $('#trainingCounts').textContent = '读取本地标注库失败'; }
}
function renderSavedModel() {
  $('#exportModel').disabled = !savedModel; $('#predictSelection').disabled = !savedModel || !selectedRange || !audioBuffer;
  if (savedModel) $('#modelStatus').textContent = `本地已保存模型 · ${savedModel.sampleCount} 个样本 · ${new Date(savedModel.createdAt).toLocaleString('zh-CN')}`;
}
async function trainLocalModel() {
  const button = $('#trainModel'); button.disabled = true; button.textContent = '准备语音特征…'; $('#modelStatus').textContent = '逐段提取音频特征；整个过程在此浏览器内运行。';
  try {
    const samples = await collectTrainingSamples(); const counts = {}; samples.forEach(sample => { counts[sample.label] = (counts[sample.label] || 0) + 1; }); const classes = Object.keys(counts).sort();
    if (classes.length < 2 || classes.some(label => counts[label] < 2)) throw new Error('需要至少 2 种情绪，且每种至少 2 段已标注语音。');
    const split = splitForValidation(samples, classes); let metrics = null;
    if (split) { $('#modelStatus').textContent = `训练验证副本：${split.train.length} 段训练，${split.validation.length} 段验证…`; await new Promise(resolve => setTimeout(resolve, 0)); const validationModel = fitEmotionClassifier(split.train, classes); metrics = evaluateClassifier(validationModel, split.validation, classes); }
    button.textContent = '正在拟合最终模型…'; await new Promise(resolve => setTimeout(resolve, 0)); const finalModel = fitEmotionClassifier(samples, classes);
    savedModel = { version: 1, createdAt: new Date().toISOString(), sampleCount: samples.length, classCounts: counts, classes, featureType: 'log-mel mean/std + energy + zero-crossing statistics', featureConfig: { sampleRate: FEATURE_RATE, fftSize: FFT_SIZE, frameSize: FRAME_SIZE, frameHop: FRAME_HOP, melBands: MEL_BANDS, summary: 'per-clip mean and standard deviation', monoMix: 'channel average', resampling: 'linear interpolation' }, trainingConfig: { classifier: 'multinomial softmax linear', epochs: 140, l2: 0.001, classWeights: 'inverse frequency', annotationConfidenceWeights: { high: 1, medium: 0.75, low: 0.5 }, validation: 'stratified segment holdout; enabled at five or more samples per class' }, featureSize: FEATURE_SIZE, ...finalModel, metrics, labelDictionary: Object.fromEntries(classes.map(code => [code, { label_zh: emotionNames[code] || code, definition: customLabels.find(label => label.code === code)?.definition || builtInDefinitions[code] || '' }])) };
    const db = await openWorkspaceDb(); await new Promise((resolve, reject) => { const tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').put(savedModel, 'model'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    renderSavedModel(); updateTrainingSummary();
    $('#modelStatus').textContent = metrics ? `模型保存在本地。验证集准确率 ${(metrics.accuracy * 100).toFixed(1)}% · Macro-F1 ${(metrics.macroF1 * 100).toFixed(1)}%（${metrics.validationSamples} 段）` : '初版模型已保存在本地。每类样本不足 5 段，暂不报告验证分数；建议每类补充更多录音。';
  } catch (error) { $('#modelStatus').textContent = error.message || '模型训练或保存失败，请检查浏览器存储空间。'; }
  finally { button.textContent = '训练 / 更新模型'; await updateTrainingSummary(); }
}
$('#trainModel').addEventListener('click', trainLocalModel);
$('#exportModel').addEventListener('click', () => { if (!savedModel) return; const blob = new Blob([JSON.stringify(savedModel, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'shengyu-emotion-model.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); });
$('#predictSelection').addEventListener('click', () => {
  if (!savedModel || !selectedRange || !audioBuffer) { setStatus('先选择一段波形区间，再执行本地预测。'); return; }
  try {
    const features = extractFeatures(audioBuffer, selectedRange.start, selectedRange.end); const probabilities = modelProbabilities(savedModel, features); const ranked = probabilities.map((probability, index) => ({ code: savedModel.classes[index], probability })).sort((a, b) => b.probability - a.probability); const top = ranked[0];
    const host = $('#predictionResult'); host.innerHTML = ''; const headline = document.createElement('div'); headline.className = 'prediction-main'; headline.textContent = `较匹配：${emotionNames[top.code] || top.code} · ${top.code}`; host.append(headline);
    const bars = document.createElement('div'); bars.className = 'prediction-bars'; ranked.forEach(row => { const line = document.createElement('div'); line.className = 'prediction-row'; const name = document.createElement('span'); name.textContent = emotionNames[row.code] || row.code; const track = document.createElement('div'); track.className = 'prediction-track'; const fill = document.createElement('i'); fill.style.width = `${row.probability * 100}%`; track.append(fill); const value = document.createElement('b'); value.textContent = `${(row.probability * 100).toFixed(1)}%`; line.append(name, track, value); bars.append(line); }); host.append(bars);
    const note = document.createElement('div'); note.textContent = '分数是此模型的相对输出，不是校准后的情绪概率；模型只适用于与标注数据相似的录音。'; host.append(note);
  } catch (_) { $('#predictionResult').textContent = '无法提取这段音频的特征。'; }
});
updateTrainingSummary();
