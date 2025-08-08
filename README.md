# Live Translate (YouTube) — Overlay MVP (CPU, one stream)

Paste any **YouTube livestream or VOD** link, and get **subtitles over the video**.
- CPU only using `faster-whisper` `tiny` (change via `WHISPER_MODEL`).
- One concurrent stream at a time (budget mode). Any visitor can paste a link.
- Subtitles are timestamped and overlaid on the YouTube player with a sync slider.

## Run locally
```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
# open http://localhost:8000
```

## Deploy to Render (Docker)
- Push this folder to GitHub.
- Render → **New → Web Service** → Environment: **Docker**.
- It will build from the `Dockerfile`.
- On success, open the URL and paste a YT link.

### Notes
- Expect ~1–4s latency on tiny model.
- Some YouTube lives (members-only/DRM/region-locked) won’t work.
- VOD seeking won’t re-align captions (MVP). Use the **offset slider** if the player isn’t aligned.
- To stop a stream cleanly, click **Stop** (or `POST /stop`).

## Options
- `srcLang`: default auto; set to `es`, `en`, etc. if you know it (slightly faster/cleaner).
- `task`: `translate` (to English) or `transcribe` (source language).
- `WHISPER_MODEL`: `tiny` (default), `base`, etc. (larger = slower, better).

## TODO ideas
- Multi-language fan-out (transcribe once, translate to multiple targets).
- Robust VOD alignment (link cues to video timecode + seeking).
- Rooms registry to allow multiple concurrent streams (requires bigger machine).
