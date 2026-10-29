import type { DatabaseSync } from "node:sqlite";

export interface OpenOptions {
  /** The only directory the database file may live under. */
  root?: string;
  busyTimeoutMs?: number;
}

export interface Migration {
  version: number;
  name: string;
  file: string;
  sql: string;
  sha256: string;
}

export function openDatabase(file: string, options?: OpenOptions): DatabaseSync;
export function readMigrations(dir: string): Migration[];
export function migrate(db: DatabaseSync, dir: string): number[];
