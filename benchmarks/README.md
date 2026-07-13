# benchmarks

One-off perf and payload-size measurements. Not part of the regular
test suite.

## Run

```bash
pnpm bench
```

(Internally: `jest --roots=./benchmarks --testMatch='<rootDir>/benchmarks/**/*.bench.ts'`.)

## Latest results

### `serialize-error.bench.ts` — full vs minimal mode

Workload: a representative HTTP-handler error with a 3-deep `Error.cause`
chain (HTTP → service → DB → I/O) and a 9-line stack trace. 100K
iterations, Linux x86_64, Node 22.

```
Payload size (JSON, bytes):
  full:               1454
  minimal:             793
  delta:               661 bytes  (45.5% of full)

CPU per call (ns):
  full:               3,386 ns
  minimal:              169 ns
  delta:              3,217 ns/call  (~20× speedup in minimal)

At 10K errors/sec sustained:
  bytes saved/sec:    ~6.3 MB/s
  cpu saved/sec:      ~33 ms (~3.4% of one core)
```

**Takeaway.** `errorEnrichment: 'minimal'` roughly halves the per-event
JSON size when there's a non-trivial cause chain. The CPU win is real
in TS (the regex stack-frame parser is the main saver) but small in
absolute terms — set this for the bytes, not the cycles.

See `emitters/go/errors_bench_test.go` and `emitters/php/benchmarks/`
in the sibling repos for the equivalent measurements in those SDKs.
