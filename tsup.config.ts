import { defineConfig } from 'tsup';

/**
 * tsup automatically uses SWC (via @swc/core) when emitDecoratorMetadata
 * is true in tsconfig.json. This preserves NestJS decorator metadata
 * (design:paramtypes) that esbuild would strip.
 */

export default defineConfig([
  {
    entry: { index: 'src/common/index.ts' },
    outDir: 'dist/common',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
  },
  {
    entry: { index: 'src/emitter/index.ts' },
    outDir: 'dist/emitter',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'neutral',
  },
  {
    entry: { index: 'src/consumer/index.ts' },
    outDir: 'dist/consumer',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'node',
    external: [
      '@nestjs/common',
      '@nestjs/core',
      '@nestjs/websockets',
      'typeorm',
      'class-validator',
      'class-transformer',
    ],
  },
  // TrackerSocketIoGateway is lazy-required by TrackerModule via a string
  // variable to hide it from the bundler — that keeps consumers without
  // @nestjs/websockets / @nestjs/platform-socket.io from blowing up on
  // import. But hiding it also means it must be emitted as a SEPARATE
  // sibling artifact (not bundled into index.js), or the runtime
  // require('./TrackerSocketIoGateway') has nothing to resolve.
  {
    entry: { TrackerSocketIoGateway: 'src/consumer/TrackerSocketIoGateway.ts' },
    outDir: 'dist/consumer',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'node',
    external: [
      '@nestjs/common',
      '@nestjs/core',
      '@nestjs/websockets',
      '@nestjs/platform-socket.io',
    ],
  },
  {
    entry: { index: 'src/consumer/storage/index.ts' },
    outDir: 'dist/consumer/storage',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'node',
    external: [
      '@nestjs/common',
      '@nestjs/core',
      'typeorm',
    ],
  },
  {
    entry: { index: 'src/consumer/notifications/index.ts' },
    outDir: 'dist/consumer/notifications',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'node',
    external: [
      '@nestjs/common',
      '@nestjs/core',
      'typeorm',
      'nodemailer',
      'firebase-admin',
    ],
  },
  {
    entry: { index: 'src/emitter/plugins/index.ts' },
    outDir: 'dist/emitter/plugins',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'neutral',
  },
  {
    entry: { index: 'src/emitter/sw/index.ts' },
    outDir: 'dist/sw',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'browser',
  },
  {
    entry: { 'tracker-sw': 'src/emitter/sw/standalone.ts' },
    outDir: 'dist',
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    platform: 'browser',
  },
  {
    entry: { 'tracker-cli': 'src/cli/tracker-cli.ts' },
    outDir: 'dist/cli',
    format: ['cjs'],
    dts: false,
    clean: false,
    sourcemap: true,
    platform: 'node',
    target: 'node18',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // ── Analytics plugin (browser-side) ─────────────────────────────────
  {
    entry: { index: 'src/analytics/index.ts' },
    outDir: 'dist/analytics',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'neutral',
  },
  // ── GA plugin (browser-side: gtag.js / GTM) ─────────────────────────
  {
    entry: { index: 'src/ga/index.ts' },
    outDir: 'dist/ga',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'neutral',
  },
  // ── GA plugin (server-side: Measurement Protocol) ───────────────────
  {
    entry: { index: 'src/ga/server/index.ts' },
    outDir: 'dist/ga/server',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'node',
    external: [
      '@nestjs/common',
      '@nestjs/core',
    ],
  },
]);
