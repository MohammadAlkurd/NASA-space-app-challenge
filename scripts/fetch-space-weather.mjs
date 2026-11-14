// Snapshot of NASA DONKI solar-storm activity for the last 7 days -> public/data/space-weather.json.
// Runs in the GitHub Actions build (daily) so the deployed map always has recent space weather
// even when a visitor's browser cannot reach the API. On any failure the committed snapshot is kept.
import { writeFile } from 'node:fs/promises';

const key = process.env.NASA_API_KEY || 'DEMO_KEY';
const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const query = `startDate=${day(7)}&endDate=${day(0)}&api_key=${key}`;

async function list(kind) {
  const response = await fetch(`https://api.nasa.gov/DONKI/${kind}?${query}`);
  if (!response.ok) throw new Error(`DONKI ${kind}: HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

try {
  const [sep, cme] = await Promise.all([list('SEP'), list('CME')]);
  const fast = cme
    .map((event) => ({ time: event.startTime, speed: Math.max(0, ...(event.cmeAnalyses ?? []).map((a) => a.speed ?? 0)) }))
    .filter((event) => event.speed >= 1000);
  const snapshot = {
    source: 'NASA DONKI (Space Weather Database Of Notifications, Knowledge, Information), CCMC',
    fetchedAt: new Date().toISOString(),
    windowDays: 7,
    sepEvents: sep.map((event) => ({ time: event.eventTime, instruments: (event.instruments ?? []).map((i) => i.displayName) })),
    cmeCount: cme.length,
    fastCmes: fast,
  };
  await writeFile(new URL('../public/data/space-weather.json', import.meta.url), `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`space weather: ${snapshot.sepEvents.length} SEP, ${snapshot.cmeCount} CME (${fast.length} fast)`);
} catch (error) {
  console.warn(`space weather snapshot not refreshed: ${error.message}`);
}
