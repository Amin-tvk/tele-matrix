FROM python:3.13-slim
RUN pip install --no-cache-dir "requests[socks]==2.32.3"
COPY bot.py /app/bot.py
USER 1000
CMD ["python", "-u", "/app/bot.py"]
