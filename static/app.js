let player;
let ws = null;
let cues = []; // {text,start,end}
let offset = 0; // seconds to shift cues on display
let displayTimer = null;

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
    // fallback: let YT handle it via cueVideoByUrl
    player.cueVideoByUrl(url);
    player.playVideo();
  }
}

function renderOverlay(){
  const overlay = $('subsOverlay');
  // Find the latest cue eligible by playback time + offset
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

function start(){
  const url = $('ytUrl').value.trim();
  if (!url) { alert('Paste a YouTube link'); return; }
  loadVideo(url);
  setStatus('Connecting…');
  cues = [];
  startOverlayLoop();

  const srcLang = $('srcLang').value || null;
  const task = $('task').value || 'translate';

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    ws.send(JSON.stringify({action:'start', url, src_lang: srcLang, task}));
  };
  ws.onmessage = (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      if (msg.error){ setStatus('Error: ' + msg.error); return; }
      if (msg.status){ setStatus(msg.status); return; }
      if (msg.cue){
        cues.push(msg.cue);
      }
      if (msg.recent){
        cues = msg.recent.concat(cues);
      }
    }catch(e){
      console.warn('Bad WS msg', ev.data);
    }
  };
  ws.onclose = () => setStatus('Disconnected');
  ws.onerror = () => setStatus('WebSocket error');
}

function stop(){
  try{
    if (ws && ws.readyState === WebSocket.OPEN){
      ws.send(JSON.stringify({action:'stop'}));
    }
  }catch(e){}
  setStatus('Stopping…');
  stopOverlayLoop();
}

$('startBtn').addEventListener('click', start);
$('stopBtn').addEventListener('click', stop);
$('offset').addEventListener('input', (e) => {
  offset = parseFloat(e.target.value || '0');
  $('offsetVal').textContent = String(offset);
});
