# PDF Worker

Worker separato per comprimere PDF con Ghostscript.

## Variabili

- `PORT` - porta HTTP, default `8080`
- `CORS_ORIGIN` - origine consentita, default `*`
- `MAX_UPLOAD_BYTES` - limite upload per il worker, default `250MB`

## Deploy

Questo worker va pubblicato come servizio separato e poi collegato al sito principale con:

- `PDF_COMPRESSION_WORKER_URL=https://...`

L'admin legge questo valore da `/api/storage/status`.

## Endpoint

- `GET /health`
- `POST /compress-pdf`

