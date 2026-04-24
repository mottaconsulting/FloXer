FROM python:3.11-slim

WORKDIR /app

COPY backend/ ./backend/
COPY frontend/ ./frontend/

RUN pip install --no-cache-dir -r backend/requirements.txt

WORKDIR /app/backend

EXPOSE 8000

CMD ["gunicorn", "app:app", "--workers", "1", "--threads", "4", "--timeout", "120", "--bind", "0.0.0.0:8000"]
