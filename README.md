# Middleware Logger

Ein HTTP/HTTPS Proxy-Server mit Logging-Funktionalität für Node.js/TypeScript.

## Features

- ✅ HTTP und HTTPS Proxy-Unterstützung
- ✅ Parallele Request-Behandlung
- ✅ Detailliertes Console-Logging
- ✅ CLI-Interface mit Commander.js
- ✅ TypeScript Support

## Installation

```bash
npm install
npm run build
```

## Verwendung

```bash
# HTTP Proxy
npm run start -- start -p 8080 -h example.com -r 80

# HTTPS Proxy
npm run start -- start -p 8080 -h example.com -r 443 --https

# Mit Body-Logging
npm run start -- start -p 8080 -h example.com -r 80 --log-body

# Lokaler HTTPS Server
npm run start -- start -p 8080 -h example.com -r 80 --local-https

# Development
npm run dev -- start -p 8080 -h example.com -r 80
```

### Parameter

- `-p, --port <port>`: Lokaler Port zum Lauschen
- `-h, --host <host>`: Remote Host-Adresse
- `-r, --remote-port <port>`: Remote Port
- `--https`: HTTPS für Remote-Verbindung verwenden
- `--local-https`: HTTPS-Verbindungen lokal akzeptieren
- `--log-body`: Request und Response Bodies loggen
- `--merge-sse`: Server-Sent Events zu lesbaren Nachrichten zusammenfassen

## Beispiel

```bash
# Proxy für httpbin.org
npm run dev -- start -p 8080 -h httpbin.org -r 443 --https

# Mit Body-Logging
npm run dev -- start -p 8080 -h httpbin.org -r 443 --https --log-body

# Mit SSE Merging (für AI API Streams)
npm run dev -- start -p 8080 -h api.anthropic.com -r 443 --https --log-body --merge-sse

# Test mit curl
curl http://localhost:8080/get
curl -X POST http://localhost:8080/post -d '{"test": "data"}' -H "Content-Type: application/json"
```

Das Logging zeigt alle eingehenden Requests und ausgehenden Responses mit Timestamps, Status Codes, Header-Informationen und optional auch die vollständigen Request/Response Bodies an.