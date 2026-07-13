# Tracker API Contract

Language-agnostic HTTP specification for tracker client implementations.

All tracker clients (TypeScript, Go, PHP, etc.) communicate with the tracker server via this HTTP API.

## Base URL

Configure the tracker server endpoint. All paths below are relative to this base.

```
https://tracker.vendidit.com
```

## Authentication

Optional. The server supports per-client API keys for server-to-server auth.

```
X-Tracker-Key: <api-key>
```

**Server-side:** Configure one or more keys via `TrackerModuleOptions.apiKey`:

```typescript
TrackerModule.register({
  apiKey: ['key-for-api-server', 'key-for-go-service', 'key-for-php-app'],
})
```

Keys are SHA-256 hashed at startup — raw values are never stored in memory.
Revoking a client = remove its key from the array; other clients are unaffected.

**Validation rules:**
- Header present + valid key → allowed
- Header present + invalid key → `403 Forbidden`
- Header absent + `publicIngestion: true` → allowed (browser clients)
- Header absent + `publicIngestion: false` → rejected by NestJS guard
- No keys configured → all requests allowed

**Generate a key:** `openssl rand -hex 32`

---

## Endpoints

### POST /tracker/events — Ingest Events

Accept a single event or a batch (JSON array).

**Request:**

```http
POST /tracker/events HTTP/1.1
Content-Type: application/json
X-Tracker-Key: <optional>

[
  {
    "type":      "error",
    "message":   "Connection refused",
    "timestamp": 1745388000000,
    "appId":     "api-server",
    "category":  "db:connection",
    "payload":   { "host": "db.example.com", "port": 5432 },
    "tags":      ["database", "critical"],
    "error": {
      "name":    "ConnectionError",
      "message": "ECONNREFUSED 127.0.0.1:5432",
      "stack":   "at TCPConnectWrap.afterConnect...",
      "file":    "/app/src/db/connection.js",
      "line":    142,
      "code":    "ECONNREFUSED",
      "previous": [
        { "name": "Error", "message": "pool acquire timeout", "file": "/app/src/db/pool.js", "line": 88 }
      ]
    },
    "context": {
      "userId":      "u-42",
      "sessionId":   "sess-abc",
      "appVersion":  "2.1.0",
      "environment": "production"
    }
  }
]
```

A single event (not in an array) is also accepted.

**Response:** `201 Created`

```json
{ "ok": true }
```

**Errors:**
- `400 Bad Request` — invalid event shape (missing `type`, `message`, or `timestamp`)
- `403 Forbidden` — invalid API key

### GET /tracker/events — Query Events

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| `appId` | string | Filter by app identifier |
| `type` | string | `error`, `warning`, `info`, `debug`, `event` |
| `status` | string | `new`, `viewed`, `acknowledged`, `in_progress`, `resolved`, `wont_fix`, `archived` |
| `category` | string | Filter by category (e.g. `db:query-failed`) |
| `userId` | string | Filter by context.userId |
| `environment` | string | Filter by context.environment |
| `from` | number | Unix ms lower bound on receivedAt |
| `to` | number | Unix ms upper bound on receivedAt |
| `limit` | number | Max results (default: 100) |
| `offset` | number | Pagination offset (default: 0) |
| `sortBy` | string | Column to sort by (default: `receivedAt`) |
| `sortDir` | string | `asc` or `desc` (default: `desc`) |
| `payload.*` | string | JSONB containment filter: `payload.orderId=123` |

**Response:** `200 OK`

```json
[
  {
    "id":         "550e8400-e29b-41d4-a716-446655440000",
    "type":       "error",
    "message":    "Connection refused",
    "timestamp":  1745388000000,
    "receivedAt": 1745388000123,
    "status":     "new",
    "appId":      "api-server",
    "category":   "db:connection",
    "payload":    { "host": "db.example.com" },
    "tags":       ["database"],
    "error":      { "name": "ConnectionError", "message": "...", "stack": "...", "file": "/app/src/db.js", "line": 142, "code": "ECONNREFUSED" },
    "context":    { "userId": "u-42", "environment": "production" },
    "count":      1
  }
]
```

### PATCH /tracker/events/:id/status — Update Status

```http
PATCH /tracker/events/550e8400-e29b-41d4-a716-446655440000/status
Content-Type: application/json

{ "status": "resolved" }
```

**Response:** `200 OK` `{ "ok": true }`

### GET /tracker/events/stream — SSE Stream

Server-Sent Events stream. Polls storage every 2 seconds and pushes new events.

```http
GET /tracker/events/stream?appId=api-server&type=error
Accept: text/event-stream
```

Each message is a `data:` line containing a JSON event.

### GET /tracker/metrics — Prometheus Metrics

Returns Prometheus text-format metrics (if PrometheusPlugin is enabled).

### GET /tracker/dashboard — Dashboard UI

Returns the self-hosted HTML dashboard.

---

## Event Schema

### TrackerEvent (client sends)

```typescript
{
  type:      "error" | "warning" | "info" | "debug" | "event"  // required
  message:   string                                             // required
  timestamp: number                                             // required, Unix ms
  appId?:    string
  category?: string
  payload?:  object                                             // arbitrary JSON
  tags?:     string[]
  error?: {
    name:      string                         // e.g. "TypeError", "ConnectionError"
    message:   string
    stack?:    string                         // full stack trace, language-native format
    file?:     string                         // throw site (parsed from top stack frame)
    line?:     number                         // line in `file`
    code?:     string | number                // SystemError.code, HTTP status, custom subclass code
    previous?: Array<{                        // wrapped-cause chain, outermost-first; capped at 5
      name:    string
      message: string
      file?:   string
      line?:   number
      code?:   string | number
    }>
  }
  context?: {
    userId?:      string
    sessionId?:   string
    appVersion?:  string
    environment?: "development" | "staging" | "production"
    // Additional fields are accepted — the context object is open
    [key: string]: any
  }
}
```

### StoredTrackerEvent (server returns)

Extends TrackerEvent with server-stamped fields:

```typescript
{
  id:         string     // UUID, generated by server
  status:     string     // "new" | "viewed" | "acknowledged" | "in_progress" | "resolved" | "wont_fix" | "archived"
  receivedAt: number     // Unix ms, stamped by server
  count?:     number     // >1 for aggregated events
  // ... all TrackerEvent fields
}
```

---

## Event Types

| Type | Severity | Description |
|---|---|---|
| `error` | Highest | Exceptions, failed operations |
| `warning` | High | Degraded state, recoverable issues |
| `info` | Medium | Significant operations |
| `debug` | Low | Diagnostic state |
| `event` | N/A | Custom analytics events |

Severity ordering: `error > warning > info > debug > event`

---

## Error Serialization by Language

All SDKs produce the same wire shape — `{ name, message, stack?, file?, line?, code?, previous? }`. Only the basic fields are guaranteed; everything else is best-effort because the data isn't always available in every language.

| Language | Native error → field source |
|---|---|
| **JavaScript / TypeScript** | `name`/`message`/`stack` from `Error`; `file`/`line` parsed from the top stack frame (V8 + SpiderMonkey/JSC formats); `code` from `err.code` (Node `SystemError`, custom subclasses); `previous` walks `Error.cause`. |
| **Go** | `name = fmt.Sprintf("%T", err)`; `message = err.Error()`; `stack` from `runtime.Stack`; `file`/`line` from the caller of `Client.Error` via `runtime.Caller(1)`; `code` from a `Code()` method (int / int64 / string) if implemented; `previous` walks `errors.Unwrap`. |
| **PHP** | `name = get_class($e)`; `message = $e->getMessage()`; `stack = $e->getTraceAsString()`; `file = $e->getFile()`; `line = $e->getLine()`; `code = $e->getCode()`; `previous` walks `$e->getPrevious()`. |
| **Python** *(future)* | `name = type(e).__name__`; `message = str(e)`; `stack = traceback.format_exc()`; `file`/`line` from `traceback.extract_tb`; `previous` walks `e.__cause__` / `e.__context__`. |

### Cross-SDK guarantees

- `previous` is **outermost-first** (the first entry is the immediate `cause` / `getPrevious` / `Unwrap`, the last is the deepest root cause).
- `previous` chains are **capped at 5 entries** — pathological wrapping doesn't blow up the payload.
- Stack traces are **omitted from `previous` entries** because the root error's `stack` already covers the throw site.
- `file` / `line` use the language's native representation — JS reports source-mapped paths only after the SourceMapEnricher runs server-side.

---

## Client Implementation Requirements

Every tracker client must implement:

1. **Configuration** — endpoint URL, appId, apiKey, environment, appVersion
2. **Convenience methods** — `error()`, `warn()`, `info()`, `debug()`, `event()`, `track()`
3. **Context management** — `setContext()`, `clearContext()` — merged into every event
4. **Batching** — queue events in memory, flush periodically or on batch size threshold
5. **Retry** — exponential backoff on HTTP failures (3 attempts, 1s/2s/4s)
6. **Flush on shutdown** — drain the queue before process exit
7. **`beforeSend` hook** — optional callback to modify/drop events before sending
8. **`minLevel` filtering** — drop events below a configured severity threshold
9. **Error serialization** — convert language-native error types to `{ name, message, stack?, file?, line?, code?, previous? }`. Only `name` and `message` are required; populate the rest when the language exposes them. Walk the wrapped-cause chain (`Error.cause`, `errors.Unwrap`, `getPrevious`) into `previous`, capped at 5 entries, outermost-first.
10. **`track()` shorthand** — auto-extract category from `"prefix:name"` format

### Batching Strategy

- Buffer events in memory (default batch size: 50, configurable)
- Flush when batch is full OR after a time interval (default: 5 seconds)
- On process exit/shutdown, flush remaining events synchronously if possible
- POST the batch as a JSON array to `POST /tracker/events`

### Retry Strategy

- On HTTP failure (network error, 5xx), retry with exponential backoff
- Max 3 attempts: immediate → 1s → 2s
- On all retries exhausted, log locally and drop (don't block the application)
- Never retry on 400 (bad request) or 403 (auth failure)

### Thread/Goroutine Safety

- The client must be safe to call from multiple threads/goroutines
- Use a channel (Go) or synchronized queue (PHP/Python) for the event buffer
- The flush loop runs in a background thread/goroutine
