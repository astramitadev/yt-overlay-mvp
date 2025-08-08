import asyncio
import json
import logging
import os
import subprocess
from typing import Optional, Dict, Any, List

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request
from faster_whisper import WhisperModel
import yt_dlp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

MODEL_SIZE = os.getenv("WHISPER_MODEL", "tiny")
_model: Optional[WhisperModel] = None

def get_model() -> WhisperModel:
    global _model
    if _model is None:
        logging.info("Loading faster-whisper model: %s", MODEL_SIZE)
        _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    return _model

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# ---- Single-stream guard (budget mode) ----
CURRENT: Dict[str, Any] = {
    "url": None,
    "proc": None,
    "task": None,
    "src_lang": None,
    "read_task": None,
    "subscribers": set(),
    "recent": [],  # last 50 cues
}

def normalize_url(u: str) -> str:
    return u.strip()

def extract_youtube_audio(page_url: str) -> Dict[str, Any]:
    """Return dict with direct audio URL and metadata."""
    ydl_opts = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "extract_flat": False,
        "quiet": True,
        "nocheckcertificate": True,
        "geo_bypass": True,
        "live_from_start": False,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(page_url, download=False)
        direct = None
        if "url" in info:
            direct = info["url"]
        elif "formats" in info and info["formats"]:
            for f in reversed(info["formats"]):
                if f.get("acodec") and f.get("url"):
                    direct = f["url"]
                    break
        if not direct:
            raise RuntimeError("No playable audio URL found")
        return {
            "direct_url": direct,
            "is_live": bool(info.get("is_live")),
            "title": info.get("title"),
            "id": info.get("id"),
            "duration": info.get("duration"),
        }

def start_ffmpeg(input_url: str) -> subprocess.Popen:
    cmd = [
        "ffmpeg", "-nostdin", "-loglevel", "error",
        "-i", input_url, "-vn",
        "-ac", "1", "-ar", "16000",
        "-f", "s16le", "pipe:1",
    ]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

async def broadcast(payload: dict):
    dead = []
    for ws in list(CURRENT["subscribers"]):
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.append(ws)
    for ws in dead:
        CURRENT["subscribers"].discard(ws)

def add_recent(cue: dict):
    CURRENT["recent"].append(cue)
    if len(CURRENT["recent"]) > 50:
        CURRENT["recent"] = CURRENT["recent"][-50:]

async def run_pipeline(url: str, src_lang: Optional[str], task: str):
    """Read PCM from ffmpeg, transcribe/translate with timestamps, broadcast cues."""
    model = get_model()
    meta = extract_youtube_audio(url)
    await broadcast({"status": f"Stream resolved: {meta.get('title','Unknown')}. Loading ffmpeg…"})
    ff = start_ffmpeg(meta["direct_url"])
    CURRENT["proc"] = ff

    sample_rate = 16000
    bytes_per_sample = 2
    chunk_seconds = 8
    chunk_bytes = sample_rate * bytes_per_sample * chunk_seconds
    buf = bytearray()
    loop = asyncio.get_running_loop()
    t0 = 0.0

    await broadcast({"status": "Transcribing…"})
    try:
        while True:
            chunk = await loop.run_in_executor(None, ff.stdout.read, 8192)
            if not chunk:
                break
            buf.extend(chunk)
            while len(buf) >= chunk_bytes:
                piece = bytes(buf[:chunk_bytes])
                del buf[:chunk_bytes]

                audio_i16 = np.frombuffer(piece, np.int16).astype(np.float32)
                audio = audio_i16 / 32768.0

                segments, info = model.transcribe(
                    audio,
                    language=src_lang if src_lang else None,
                    task=task,
                    vad_filter=True,
                    beam_size=1
                )

                # Build a cue combining all segment text in this chunk
                text = "".join(seg.text for seg in segments).strip()
                if text:
                    # Compute segment-relative start/end (best-effort)
                    seg_start = t0 + (segments[0].start or 0.0)
                    seg_end = t0 + (segments[-1].end or chunk_seconds)
                    cue = {"text": text, "start": float(seg_start), "end": float(seg_end)}
                    add_recent(cue)
                    await broadcast({"cue": cue})

                t0 += chunk_seconds
    except Exception as e:
        logging.exception("Pipeline error: %s", e)
        await broadcast({"error": str(e)})
    finally:
        try:
            if ff and ff.poll() is None:
                ff.terminate()
        except Exception:
            pass
        CURRENT["proc"] = None
        CURRENT["url"] = None
        CURRENT["task"] = None
        CURRENT["src_lang"] = None
        await broadcast({"status": "Stream ended."})

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    CURRENT["subscribers"].add(ws)
    try:
        # send recent cues if any (useful for late joiners)
        if CURRENT["recent"]:
            await ws.send_text(json.dumps({"recent": CURRENT["recent"]}))

        while True:
            msg = await ws.receive_text()
            data = json.loads(msg)
            action = data.get("action")

            if action == "start":
                url = normalize_url(data.get("url",""))
                if not url:
                    await ws.send_text(json.dumps({"error": "Missing url"}))
                    continue
                src_lang = data.get("src_lang") or None
                task = data.get("task") or "translate"

                if CURRENT["proc"] and CURRENT["url"] and url != CURRENT["url"]:
                    await ws.send_text(json.dumps({"error": "Another stream is currently running. Try again later."}))
                    continue

                # join existing stream
                if CURRENT["proc"] and url == CURRENT["url"]:
                    await ws.send_text(json.dumps({"status": "Joined current stream."}))
                    continue

                # start new stream
                CURRENT["url"] = url
                CURRENT["task"] = task
                CURRENT["src_lang"] = src_lang
                CURRENT["recent"] = []

                await ws.send_text(json.dumps({"status": "Resolving stream…"}))
                CURRENT["read_task"] = asyncio.create_task(run_pipeline(url, src_lang, task))

            elif action == "stop":
                if CURRENT["proc"]:
                    try:
                        CURRENT["proc"].terminate()
                    except Exception:
                        pass
                await ws.send_text(json.dumps({"status": "Stopping…"}))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logging.exception("WS error: %s", e)
        try:
            await ws.send_text(json.dumps({"error": str(e)}))
        except Exception:
            pass
    finally:
        CURRENT["subscribers"].discard(ws)

@app.post("/stop")
def stop_stream():
    if not CURRENT["proc"]:
        raise HTTPException(400, "No active stream")
    try:
        CURRENT["proc"].terminate()
    except Exception:
        pass
    return {"ok": True}

@app.get("/health")
def health():
    return {"ok": True, "active": bool(CURRENT["proc"]), "url": CURRENT["url"]}
