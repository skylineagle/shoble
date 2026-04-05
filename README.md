# Shoble

A multi-service system for querying spectrum analyzers over TCP via named stations. Comprised of three services:

- **PocketBase** — database storing stations, systems, and spectrum endpoints
- **Bun/ElysiaJS server** — typed HTTP API that routes queries to spectrum analyzers over TCP
- **n8n** — workflow automation with custom Shoble nodes for building integrations

## Architecture

```
┌─────────────┐     GET station info     ┌──────────────┐
│   n8n       │ ──────────────────────── │  PocketBase  │
│  workflows  │                          │  :8090       │
└──────┬──────┘                          └──────────────┘
       │ POST /query/:station                    ▲
       ▼                                         │ GET station info
┌─────────────┐     TCP + \n framing     ┌──────┴──────┐
│   Shoble    │ ──────────────────────── │  Spectrum   │
│   server    │ ◄─────────────────────── │  Analyzer   │
│   :3000     │                          └─────────────┘
└─────────────┘
```

### Data model

- **systems** — a named group (e.g. a site or facility)
- **spectrums** — a spectrum analyzer endpoint: `host` (IPv4), `port` (1–65535), optional `name`
- **stations** — named entry that links one system and one spectrum analyzer

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- [Docker](https://docs.docker.com/get-docker/) + Docker Compose v2

---

## Development

The dev environment runs PocketBase and n8n in Docker while the Bun server runs locally with hot-reload. Migrations and hooks are volume-mounted so changes take effect without rebuilding.

### 1. Install dependencies

```sh
bun install
```

### 2. Configure environment

```sh
cp .env.example .env
```

The defaults work out of the box for local dev. Edit `.env` if you need to change ports or credentials.

### 3. Build custom n8n nodes and start PocketBase + n8n

Custom nodes are loaded from `packages/n8n-nodes` via bind mounts (no Docker image rebuild when you change them). The repo’s `node_modules` is mounted as well so Bun’s workspace symlinks for `pocketbase` resolve inside the container. Use Compose Watch so n8n **restarts automatically** when `dist/` updates after TypeScript compiles.

Terminal A — compile nodes on every save:

```sh
bun run dev:nodes
```

Terminal B — first compile once if `dist/` is empty, then start the stack with file watch:

```sh
bun run build:nodes
docker compose up --watch
```

Without `--watch`, restart the `n8n` container yourself after pulls (`docker compose restart n8n`) so it reloads extensions.

Production-style n8n with nodes baked into the image is still available via `docker-compose.prod.yml`.

| Service    | URL                       |
|------------|---------------------------|
| PocketBase | http://localhost:8090/_/  |
| n8n        | http://localhost:5678     |

On first run PocketBase will apply migrations automatically, creating the `systems`, `spectrums`, and `stations` collections.

**PocketBase admin setup** — open http://localhost:8090/_/ and create an admin account (one-time only; credentials are stored in `data/pocketbase/` which is gitignored).

### 4. Run the server locally

```sh
bun run dev:server
```

The server starts on http://localhost:3000 with hot-reload. Swagger UI is available at http://localhost:3000/swagger.

### 5. Configure n8n credentials

1. Open n8n at http://localhost:5678 (login: `admin` / `changeme` or whatever you set in `.env`)
2. Go to **Credentials → New** and search for **Shoble API**
3. Set:
   - **PocketBase URL**: `http://pocketbase:8090` (uses Docker internal hostname)
   - **Shoble Server URL**: `http://host.docker.internal:3000` (reaches your local server from inside Docker)

### Available n8n nodes

| Node | Description |
|------|-------------|
| **Shoble: Get Station** | Fetch a single station by name with its system and spectrum details |
| **Shoble: List Stations** | List all stations, optionally filtered by system name |
| **Shoble: Execute Query** | Raw SCPI or PocketBase `station_queries` (list pick, form parameters from `parameter_defs`) |
| **Shoble: Execute Query and Validate** | Same execution plus assertions; **pass** and **fail** outputs |

### Linting and formatting

```sh
bun run check   # lint + format (auto-fix)
bun run lint    # lint only
bun run format  # format only
```

### Adding migrations

PocketBase migrations live in `packages/pocketbase/pb_migrations/`. They run automatically on startup. Name new files with a timestamp prefix:

```
YYYYMMDDHHMMSS_description.js
```

### Adding hooks

PocketBase hooks live in `packages/pocketbase/pb_hooks/`. Drop `.js` files there and restart the `pocketbase` container — the volume mount picks them up instantly.

---

## Production deployment

Production builds all three services as Docker images. Migrations are baked into the PocketBase image. Data is persisted in named Docker volumes.

### 1. Provision a server

Any Linux host with Docker + Docker Compose v2. The host needs ports `8090`, `3000`, and `5678` accessible (or behind a reverse proxy).

### 2. Clone and configure

```sh
git clone <repo> shoble && cd shoble
cp .env.example .env
```

Edit `.env` and set strong values for all secrets:

```env
POCKETBASE_ADMIN_EMAIL=admin@yourdomain.com
POCKETBASE_ADMIN_PASSWORD=<strong password>

N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=<strong password>
N8N_HOST=n8n.yourdomain.com
N8N_PROTOCOL=https
```

### 3. Build and start

```sh
docker compose -f docker-compose.prod.yml up -d --build
```

This builds images for PocketBase (with migrations baked in), the Bun server, and n8n (with the custom Shoble nodes installed), then starts all three.

### 4. Initialize PocketBase admin

On first deploy, create the admin account:

```sh
docker compose -f docker-compose.prod.yml exec pocketbase \
  /pb/pocketbase admin create <email> <password>
```

### 5. Configure n8n credentials (production)

1. Open n8n at your configured host
2. Go to **Credentials → New → Shoble API**
3. Set:
   - **PocketBase URL**: `http://pocketbase:8090` (internal Docker network)
   - **Shoble Server URL**: `http://server:3000` (internal Docker network)

### Updating

```sh
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

PocketBase applies any new migrations automatically on startup. n8n and server containers are replaced in-place; data volumes are preserved.

### Viewing logs

```sh
# All services
docker compose -f docker-compose.prod.yml logs -f

# Single service
docker compose -f docker-compose.prod.yml logs -f pocketbase
docker compose -f docker-compose.prod.yml logs -f server
docker compose -f docker-compose.prod.yml logs -f n8n
```

---

## Project structure

```
shoble/
├── packages/
│   ├── pocketbase/
│   │   ├── Dockerfile              # Bakes migrations + hooks into image
│   │   ├── pb_migrations/          # JS migration files (auto-applied on startup)
│   │   └── pb_hooks/               # JS hook files
│   ├── server/
│   │   └── src/
│   │       ├── index.ts            # Elysia app — POST /query/:station
│   │       ├── pocketbase.ts       # PocketBase SDK client
│   │       └── tcp.ts              # Bun TCP socket with \n framing
│   └── n8n-nodes/
│       ├── Dockerfile              # Multi-stage: compiles TS → installs into n8n image
│       └── src/
│           ├── credentials/        # ShobleApi credential type
│           └── nodes/              # GetStation, ListStations, ExecuteQuery
├── docker-compose.yml              # Dev (pb + n8n from stock image + bind-mounted custom nodes)
├── docker-compose.prod.yml         # Prod (all services containerised, named volumes)
└── .env.example
```
