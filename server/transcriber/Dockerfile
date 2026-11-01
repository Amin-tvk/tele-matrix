FROM python:3.12-slim
RUN pip install --no-cache-dir faster-whisper==1.1.1 av==13.1.0 aiohttp==3.11.18 requests
COPY app.py /app/app.py
ENV HF_HOME=/models
CMD ["python", "/app/app.py"]
