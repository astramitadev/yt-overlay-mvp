FROM python:3.10-slim

# ffmpeg for audio
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

ENV PORT=10000
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
