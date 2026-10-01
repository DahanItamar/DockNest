FROM python:3.12-alpine
WORKDIR /app
COPY app.py /app/app.py
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=2s --timeout=2s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/')"
CMD ["python", "/app/app.py"]
