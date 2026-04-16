FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY reverse_etl.py .

CMD ["python", "reverse_etl.py"]
