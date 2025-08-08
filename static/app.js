let player;
let ws = null;
let wsHealthy = false;
let cues = []; // {text,start,end}
let offset = 0; // seconds to shift cues on display
let displayTimer = null;
let pollTimer = null;

const $ = (id) => document.getElementById(id);

function onYouTubeIframeAPIReady(){
  player = new YT.Player('player', {
    height: '390',
    width: '640',
    videoId: null,
    playerVars: { autoplay: 0, playsinline: 1 },
    events: { 'onReady': onPlayerReady }
  });
}

function onPlayerReady(){
  const params = new URLSearchParams(location.search);
  const u = params.get('url');
  if (u) {
    $('ytUrl').value = u;
    start();
  }
}

function setStatus(msg){ $('status').textContent = msg; }
function appendLiveText(text){
  const box = $('liveText');
  box.textContent += (box.textContent ? '\n' : '') + text;
  box.scrollTop = box.scrollHeight;
}

function extractVideoId(url){
  try{
    const u = new URL(url);
    if (u.host.includes('youtube.com')) {
      return u.searchParams.get('v'); // watch?v=
    }
    if (u.host.includes('youtu.be')) {
      return u.pathname.slice(1);
    }
  }catch(e){}
  return null;
}

function loadVideo(url){
  const id = extractVideoId(url);
  if (id){
    player.loadVideoById(id);
  } else {
    player.cueVideoByUrl(url);
    player.playVideo();
  }
}

function renderOverlay(){
  const overlay = $('subsOverlay');
  const t = (player && player.getCurrentTime) ? player.getCurrentTime() : 0;
  const now = t + offset;
  const active = cues.filter(c => now >= c.start && now <= c.end);
  const latest = active.length ? active[active.length-1] : null;
  overlay.innerHTML = latest ? `<div class="line"><strong>${latest.text}</strong></div>` : "";
}

function startOverlayLoop(){
  if (displayTimer) clearInterval(displayTimer);
  displayTimer = setInterval(renderOverlay, 100);
}

function stopOverlayLoop(){
  if (displayTimer) clearInterval(displayTimer);
  displayTimer = null;
  $('subsOverlay').innerHTML = "";
}

function startPolling(){
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try{
      const r = await fetch('/api/recent');
      const data = await r.json();
      if (Array.isArray(data.recent)){
        cues = data.recent;
      }
      if (data.last_text){
        appendLiveText(data.last_text);
      }
      if (!data.active){
        clearInterval(pollTimer);
      }
    }catch(e){ /* ignore */ }
  }, 1500);
}

function stopPolling(){
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function start(){
  const url = $('ytUrl').value.trim();
  if (!url) { alert('Paste a YouTube link'); return; }
  loadVideo(url);
  setStatus('Connecting…');
  cues = [];
  $('liveText').textContent = '';
  startOverlayLoop();
  stopPolling();
  wsHealthy = false;

  const srcLang = $('srcLang').value || null;
  const task = $('task').value || 'translate';

  // Try WebSocket first
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  let wsTimeout = setTimeout(async () => {
    if (!wsHealthy){
      setStatus('WS slow — falling back to HTTP mode…');
      try{
        await fetch('/api/start', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url, src_lang:srcLang, task})});
        startPolling();
      }catch(e){
        setStatus('Fallback failed. Reload and try again.');
      }
    }
  }, 2000);

  ws.onopen = () => {
    ws.send(JSON.stringify({action:'start', url, src_lang: srcLang, task}));
  };
  ws.onmessage = (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      if (msg.error){ setStatus('Error: ' + msg.error); return; }
      if (msg.status){ setStatus(msg.status); wsHealthy = true; return; }
      if (msg.cue){
        cues.push(msg.cue);
        appendLiveText(msg.cue.text);
        wsHealthy = true;
      }
      if (msg.recent){
        cues = msg.recent.concat(cues);
        wsHealthy = true;
      }
    }catch(e){}
  };
  ws.onclose = () => { if(!wsHealthy) setStatus('WS closed. Using HTTP mode.'); };
  ws.onerror = () => { if(!wsHealthy) setStatus('WS error. Using HTTP mode.'); };
}

function stop(){
  try{
    if (ws && ws.readyState === WebSocket.OPEN){
      ws.send(JSON.stringify({action:'stop'}));
    }
  }catch(e){}
  fetch('/api/stop', {method:'POST'}).catch(()=>{});
  setStatus('Stopping…');
  stopOverlayLoop();
  stopPolling();
}

$('startBtn').addEventListener('click', start);
$('stopBtn').addEventListener('click', stop);
$('offset').addEventListener('input', (e) => {
  offset = parseFloat(e.target.value || '0');
  $('offsetVal').textContent = String(offset);
});

