import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readDownloadStats(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Statistics must be a regular file');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const enabledAt = db.prepare("SELECT value FROM metadata WHERE key='enabled_at'").get()?.value;
    const daily = db.prepare('SELECT * FROM daily ORDER BY day DESC,artifact').all();
    return { enabledAt, timezone: 'UTC', retentionDays: 365,
      semantics: 'full_downloads counts finished HTTP 200 file responses, not people or installations. Range responses are separate. bytes_sent is body bytes written to the connection.', daily };
  } finally { db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Usage: node stats.mjs /stats/downloads.sqlite');
  console.log(JSON.stringify(readDownloadStats(process.argv[2]), null, 2));
}
