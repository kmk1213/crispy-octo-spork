FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && groupadd --system radar \
    && useradd --system --gid radar --home-dir /app radar

COPY --chown=radar:radar . ./
USER radar

EXPOSE 8080
CMD ["sh", "-c", "exec gunicorn --bind \"0.0.0.0:${PORT}\" --workers 2 --threads 4 --timeout 60 app:app"]
