# Tracker Architecture

## System Overview

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': {'fontSize': '18px', 'fontFamily': 'Inter, system-ui, sans-serif', 'primaryColor': '#6366f1', 'primaryTextColor': '#f5f5f4', 'primaryBorderColor': '#818cf8', 'lineColor': '#a78bfa', 'secondaryColor': '#1e1b4b', 'tertiaryColor': '#292524', 'edgeLabelBackground': '#1c1917'}, 'flowchart': {'nodeSpacing': 40, 'rankSpacing': 60, 'padding': 60, 'curve': 'basis'}}}%%

graph TB
    subgraph Clients[" CLIENT APPLICATIONS "]
        direction LR
        BP["Buyer Portal\nTypeScript"]
        SP["Seller Portal\nTypeScript"]
        API["API Server\nTypeScript"]
        GO_SVC["Go Service\nGo Client"]
        PHP_APP["PHP App\nPHP Client"]
    end

    subgraph Ingestion[" GO INGEST · :4011 "]
        VALIDATE["Validate API Key\nSHA-256 Set · O 1"]
        PARSE["Parse + Validate\ntype · message · timestamp"]
        PUSH["LPUSH to Redis"]
    end

    subgraph Queue[" MESSAGE QUEUE "]
        REDIS[("Redis :6380\nLIST tracker:ingest")]
    end

    subgraph Processing[" NESTJS TRACKER · :4010 "]
        subgraph Consumer[" Redis Consumer "]
            RPOP["RPOP batch\n100 events / 500ms"]
        end
        subgraph Pipeline[" Processing Pipeline "]
            ENRICH["Enrichers\nGeoIP · UserAgent · SourceMap"]
            INGEST["Plugin onIngest\nsequential · can veto"]
            DEDUP["Deduplication\nSHA-256 · 5min window"]
            STAMP["Stamp\nUUID · status · receivedAt"]
            PLUGINS["Plugin onEvent\nconcurrent waves"]
        end
        INSERT["Storage Plugin\nBatch INSERT · raw SQL"]
        subgraph Serve[" HTTP Endpoints "]
            direction LR
            DASH["Dashboard\n/tracker/dashboard"]
            QUERY["Query API\n/tracker/events"]
            SSE["SSE Stream\n/tracker/events/stream"]
            METRICS["Prometheus\n/tracker/metrics"]
        end
    end

    subgraph DB[" STORAGE "]
        TSDB[("TimescaleDB :5436\nHypertable · 1-day chunks\nauto-compression")]
    end

    BP -->|"POST /ingest/events\nX-Tracker-Key"| VALIDATE
    SP --> VALIDATE
    API --> VALIDATE
    GO_SVC --> VALIDATE
    PHP_APP --> VALIDATE

    VALIDATE --> PARSE --> PUSH
    PUSH -->|"LPUSH"| REDIS
    REDIS -->|"RPOP"| RPOP
    RPOP --> ENRICH --> INGEST --> DEDUP --> STAMP --> PLUGINS
    PLUGINS --> INSERT
    INSERT --> TSDB

    TSDB -.->|"SELECT"| QUERY
    TSDB -.->|"poll 2s"| SSE
    TSDB -.->|"SELECT"| DASH

    classDef client fill:#312e81,stroke:#6366f1,color:#e0e7ff,stroke-width:2px
    classDef go fill:#064e3b,stroke:#10b981,color:#d1fae5,stroke-width:2px
    classDef redis fill:#7f1d1d,stroke:#ef4444,color:#fecaca,stroke-width:2px
    classDef nest fill:#78350f,stroke:#f59e0b,color:#fef3c7,stroke-width:2px
    classDef db fill:#3b0764,stroke:#a855f7,color:#f3e8ff,stroke-width:2px
    classDef serve fill:#14532d,stroke:#22c55e,color:#dcfce7,stroke-width:2px

    class BP,SP,API,GO_SVC,PHP_APP client
    class VALIDATE,PARSE,PUSH go
    class REDIS redis
    class RPOP,ENRICH,INGEST,DEDUP,STAMP,PLUGINS,INSERT nest
    class TSDB db
    class DASH,QUERY,SSE,METRICS serve
```

## Event Lifecycle

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': {'fontSize': '16px', 'fontFamily': 'Inter, system-ui, sans-serif', 'actorTextColor': '#e7e5e4', 'actorBkg': '#312e81', 'actorBorder': '#6366f1', 'signalColor': '#a78bfa', 'signalTextColor': '#e7e5e4', 'labelBoxBkgColor': '#1e1b4b', 'labelBoxBorderColor': '#6366f1', 'labelTextColor': '#c7d2fe', 'noteBkgColor': '#292524', 'noteTextColor': '#d6d3d1', 'noteBorderColor': '#57534e', 'activationBkgColor': '#312e81', 'activationBorderColor': '#6366f1'}, 'sequence': {'mirrorActors': false, 'actorFontSize': 16, 'messageFontSize': 15, 'noteFontSize': 14}}}%%

sequenceDiagram
    participant C as Client App
    participant G as Go Ingest :4011
    participant R as Redis LIST
    participant N as NestJS :4010
    participant P as Pipeline
    participant D as TimescaleDB

    Note over C,D: 1 · EVENT CAPTURE
    C->>C: tracker.error(new Error('...'))
    C->>C: Enrichers → Plugins → beforeSend
    C->>C: Queue event in memory

    Note over C,D: 2 · BATCH FLUSH
    C->>G: POST /ingest/events [batch]
    G->>G: Validate API key
    G->>G: Parse + validate JSON
    G->>R: LPUSH event JSON
    G-->>C: 201 {"ok": true}

    Note over C,D: 3 · CONSUMER POLL
    loop Every 500ms
        N->>R: RPOP (batch of 100)
        R-->>N: event JSON[]
    end

    Note over C,D: 4 · PROCESSING PIPELINE
    N->>P: TrackerService.track(event)
    P->>P: Enrichers (GeoIP, UA)
    P->>P: onIngest (can veto)
    P->>P: Dedup check (5min)
    P->>P: Stamp id + status
    P->>P: onEvent (concurrent)

    Note over C,D: 5 · STORAGE
    P->>D: INSERT INTO tracker_events
    D-->>P: OK

    Note over C,D: 6 · DASHBOARD
    Note right of D: SSE polls every 2s
```

## Client-Side Pipeline

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': {'fontSize': '17px', 'fontFamily': 'Inter, system-ui, sans-serif', 'primaryColor': '#312e81', 'primaryTextColor': '#e0e7ff', 'primaryBorderColor': '#6366f1', 'lineColor': '#a78bfa', 'edgeLabelBackground': '#1c1917'}, 'flowchart': {'nodeSpacing': 30, 'rankSpacing': 50, 'padding': 60, 'curve': 'basis'}}}%%

flowchart LR
    subgraph Client[" TRACKER CLIENT "]
        CAP["capture()"] --> SEV{"minLevel\nfilter"}
        SEV -->|"pass"| RL{"Rate\nLimit"}
        SEV -->|"drop"| DROP1["Dropped"]
        RL -->|"allow"| EN["Enrichers"]
        RL -->|"drop"| DROP2["Rate limited"]
        EN --> PLG["Plugin\nonCapture"]
        PLG --> BS{"beforeSend"}
        BS -->|"event"| Q["Queue"]
        BS -->|"null"| DROP3["Dropped"]
    end

    subgraph Delivery[" TRANSPORT "]
        Q -->|"batch full\nor 5s timer"| T{"Transport\nType"}
        T -->|"HTTP"| HTTP["POST /ingest/events\n+ X-Tracker-Key"]
        T -->|"Direct"| DIRECT["TrackerService.track()\nno network"]
    end

    classDef drop fill:#7f1d1d,stroke:#ef4444,color:#fecaca,stroke-width:2px
    classDef queue fill:#312e81,stroke:#6366f1,color:#e0e7ff,stroke-width:2px
    classDef transport fill:#064e3b,stroke:#10b981,color:#d1fae5,stroke-width:2px

    class DROP1,DROP2,DROP3 drop
    class Q queue
    class HTTP,DIRECT transport
```

## Server-Side Processing

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': {'fontSize': '17px', 'fontFamily': 'Inter, system-ui, sans-serif', 'primaryColor': '#312e81', 'primaryTextColor': '#e0e7ff', 'primaryBorderColor': '#6366f1', 'lineColor': '#a78bfa', 'edgeLabelBackground': '#1c1917'}, 'flowchart': {'nodeSpacing': 30, 'rankSpacing': 45, 'padding': 60, 'curve': 'basis'}}}%%

flowchart TB
    subgraph Input[" EVENT SOURCES "]
        HTTP["POST /tracker/events\ndirect HTTP"]
        REDIS["Redis LIST consumer\nfrom Go ingest"]
    end

    subgraph Service[" TRACKER SERVICE "]
        MAX["maxEventBytes check\ntruncate long payloads"]
        ENR["Server Enrichers\nsequential"]
        ING["Plugin onIngest\nsequential · can veto"]
        DED{"Deduplication\ncheck"}
        DED -->|"duplicate"| SKIP["Skipped"]
        DED -->|"unique"| STMP["Stamp\nid · status · receivedAt"]
        STMP --> WAVE["Plugin onEvent\nconcurrent waves"]
    end

    subgraph Outputs[" ACTIVE PLUGINS "]
        direction LR
        STORE["EventStoragePlugin\nINSERT → TimescaleDB"]
        NOTIFY["NotificationsPlugin\nemail · Slack · Discord"]
        PROM["PrometheusPlugin\ntracker_events_total"]
        FWD["ForwardingPlugin\nPOST → endpoint"]
    end

    HTTP --> MAX
    REDIS --> MAX
    MAX --> ENR --> ING --> DED
    WAVE --> STORE
    WAVE --> NOTIFY
    WAVE --> PROM
    WAVE --> FWD

    classDef skip fill:#7f1d1d,stroke:#ef4444,color:#fecaca,stroke-width:2px
    classDef input fill:#064e3b,stroke:#10b981,color:#d1fae5,stroke-width:2px
    classDef plugin fill:#1e1b4b,stroke:#818cf8,color:#c7d2fe,stroke-width:2px

    class SKIP skip
    class HTTP,REDIS input
    class STORE,NOTIFY,PROM,FWD plugin
```

## Database Schema (TimescaleDB)

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': {'fontSize': '16px', 'fontFamily': 'Inter, system-ui, sans-serif'}, 'er': {'fontSize': 16}}}%%

erDiagram
    tracker_events {
        uuid id PK "generated UUID"
        varchar type "error | warning | info | debug | event"
        text message "event description"
        varchar appId "source application"
        varchar category "e.g. db:query-failed"
        varchar status "new | viewed | resolved | ..."
        jsonb payload "arbitrary event data"
        jsonb error "name, message, stack"
        jsonb context "userId, sessionId, env"
        text tags "comma-separated"
        bigint timestamp "client Unix ms"
        bigint receivedAt "server Unix ms (partition key)"
    }
```

**Indexes:**

| Type | Columns | Purpose |
|---|---|---|
| B-tree | `type` | Filter by event type |
| B-tree | `appId` | Filter by source app |
| B-tree | `category` | Filter by error category |
| B-tree | `status` | Filter by lifecycle status |
| B-tree | `receivedAt DESC` | Time-range queries |
| B-tree composite | `(appId, type, receivedAt DESC)` | Primary dashboard query |
| GIN jsonb_path_ops | `payload` | Payload field lookups via `@>` |
| GIN jsonb_path_ops | `context` | Context field lookups via `@>` |
| B-tree expression | `context->>'userId'` | User-specific queries |
| B-tree expression | `context->>'environment'` | Environment filtering |
| B-tree expression | `context->>'sessionId'` | Session tracking |
| GIN tsvector | `tags` | Full-text tag search |

**TimescaleDB features:**
- Hypertable partitioned by `receivedAt` (1-day chunks)
- Compression policy: chunks older than 7 days auto-compressed
- Compression segmentby: `appId`, `type`
- Compression orderby: `receivedAt DESC`

## Deployment (ven-misc)

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': {'fontSize': '17px', 'fontFamily': 'Inter, system-ui, sans-serif', 'primaryColor': '#312e81', 'primaryTextColor': '#e0e7ff', 'primaryBorderColor': '#6366f1', 'lineColor': '#a78bfa', 'edgeLabelBackground': '#1c1917'}, 'flowchart': {'nodeSpacing': 40, 'rankSpacing': 55, 'padding': 60, 'curve': 'basis'}}}%%

graph TB
    subgraph Internet[" INTERNET "]
        CLIENTS["Client Applications\nBrowser · Node · Go · PHP"]
    end

    subgraph Server[" VEN-MISC · 18.217.9.116 "]
        subgraph Nginx[" NGINX · :443 · SSL "]
            direction LR
            R1["/ingest/*"]
            R2["/tracker/*"]
        end

        subgraph Apps[" APPLICATIONS "]
            GO["Go Ingest\nPM2 :4011\n~5MB RAM"]
            NEST["NestJS Tracker\nPM2 :4010\n~120MB RAM"]
        end

        subgraph Containers[" DOCKER "]
            direction LR
            TSDB[("TimescaleDB\n:5436")]
            RED[("Redis\n:6380")]
            PG[("Postgres\n:5435\nRFP system")]
        end
    end

    CLIENTS -->|"HTTPS"| Nginx
    R1 --> GO
    R2 --> NEST
    GO -->|"LPUSH"| RED
    NEST -->|"RPOP"| RED
    NEST -->|"SQL"| TSDB

    classDef internet fill:#1e1b4b,stroke:#6366f1,color:#c7d2fe,stroke-width:2px
    classDef nginx fill:#292524,stroke:#78716c,color:#d6d3d1,stroke-width:2px
    classDef app fill:#064e3b,stroke:#10b981,color:#d1fae5,stroke-width:2px
    classDef docker fill:#1e3a5f,stroke:#3b82f6,color:#bfdbfe,stroke-width:2px

    class CLIENTS internet
    class R1,R2 nginx
    class GO,NEST app
    class TSDB,RED,PG docker
```
