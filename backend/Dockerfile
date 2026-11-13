FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY requirements.lock requirements.txt ./
# Keep HTTP responses and wheels on the builder, outside the runtime image.
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    python -m pip install --disable-pip-version-check -r requirements.lock -r requirements.txt

COPY app/ ./app/
RUN chown -R app:app /app

USER app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
