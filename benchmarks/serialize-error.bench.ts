/**
 * @jest-environment node
 *
 * Benchmark: serializeError full vs minimal.
 *
 * Not part of the default `pnpm test` run — jest's `testMatch` only
 * picks up `tests/**`. Invoke with:
 *
 *   pnpm bench:errors
 *
 * Or directly:
 *
 *   pnpm exec jest --rootDir=. --testMatch='<rootDir>/benchmarks/**\/*.bench.ts'
 */
import { serializeError } from '../src/emitter/serialize-error';

function makeRealisticError(): Error {
  // 3-deep cause chain modelled on a real Node backend stack: an HTTP
  // request handler that wraps a service-layer error that wraps the
  // underlying I/O error. Representative of what an instrumented
  // NestJS/Express app captures.
  const ioErr   = Object.assign(new Error('ECONNREFUSED 127.0.0.1:5432 - connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const dbErr   = Object.assign(new Error('failed to acquire pool client: connection refused'), { cause: ioErr });
  const svcErr  = Object.assign(new Error('OrderService.create: persistence failed'), { cause: dbErr });
  const httpErr = Object.assign(new TypeError('POST /api/orders failed: 500 Internal Server Error'), { cause: svcErr });

  // Force a realistic stack onto the outer error so the regex parser
  // has representative input.
  httpErr.stack = [
    'TypeError: POST /api/orders failed: 500 Internal Server Error',
    '    at OrderController.create (/app/dist/controllers/order.controller.js:142:23)',
    '    at /app/node_modules/@nestjs/core/router/router-execution-context.js:38:29',
    '    at /app/node_modules/@nestjs/core/router/router-proxy.js:9:17',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at async Server.<anonymous> (/app/node_modules/@nestjs/core/router/router-execution-context.js:46:28)',
    '    at async OrderController.create (/app/src/orders/order.controller.ts:88:5)',
    '    at async OrderService.create (/app/src/orders/order.service.ts:142:7)',
    '    at async DbPool.withConnection (/app/src/db/pool.ts:56:14)',
  ].join('\n');
  return httpErr;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function bench(fn: () => void, iters: number): { totalMs: number; perCallNs: number } {
  for (let i = 0; i < 1000; i++) fn();           // warmup
  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const end = process.hrtime.bigint();
  const totalNs = Number(end - start);
  return { totalMs: totalNs / 1e6, perCallNs: totalNs / iters };
}

describe('serializeError benchmark — full vs minimal', () => {
  it('reports payload size and CPU per call', () => {
    const err = makeRealisticError();
    const ITERS = 100_000;

    const fullBytes    = bytesOf(serializeError(err, 'full'));
    const minimalBytes = bytesOf(serializeError(err, 'minimal'));
    const fullPerf     = bench(() => serializeError(err, 'full'),    ITERS);
    const minimalPerf  = bench(() => serializeError(err, 'minimal'), ITERS);

    /* eslint-disable no-console */
    console.log('\n────── serializeError benchmark ──────');
    console.log(`Iterations:           ${ITERS.toLocaleString()}`);
    console.log(`Stack lines:          ${(err.stack ?? '').split('\n').length}`);
    console.log(`Cause-chain depth:    3`);
    console.log('');
    console.log('Payload size (JSON, bytes):');
    console.log(`  full:               ${fullBytes}`);
    console.log(`  minimal:            ${minimalBytes}`);
    console.log(`  delta:              ${fullBytes - minimalBytes} bytes  (${((fullBytes - minimalBytes) / fullBytes * 100).toFixed(1)}% of full)`);
    console.log('');
    console.log('CPU per call (ns):');
    console.log(`  full:               ${fullPerf.perCallNs.toFixed(0).padStart(7)} ns  (${fullPerf.totalMs.toFixed(1)} ms total)`);
    console.log(`  minimal:            ${minimalPerf.perCallNs.toFixed(0).padStart(7)} ns  (${minimalPerf.totalMs.toFixed(1)} ms total)`);
    console.log(`  delta:              ${(fullPerf.perCallNs - minimalPerf.perCallNs).toFixed(0).padStart(7)} ns/call`);
    console.log('');
    console.log('At 10K errors/sec sustained:');
    console.log(`  bytes saved/sec:    ${((fullBytes - minimalBytes) * 10_000).toLocaleString()} bytes  (${((fullBytes - minimalBytes) * 10_000 / 1024 / 1024).toFixed(2)} MB/s)`);
    console.log(`  cpu saved/sec:      ${((fullPerf.perCallNs - minimalPerf.perCallNs) * 10_000 / 1e6).toFixed(2)} ms`);
    console.log('──────────────────────────────────────\n');

    expect(fullBytes).toBeGreaterThan(minimalBytes);
  });
});
