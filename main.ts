// The entry <-> env lifecycle.
//
// In a trial the env names itself through MAKEFUN_ENV_URL. The process binds
// an ephemeral port (never 8080 — the env owns that), POSTs the port to
// $MAKEFUN_ENV_URL/register, then polls $MAKEFUN_ENV_URL/done until the env
// answers {"done": true}, closes the server and exits 0. The first register
// wins: a 409 means another process already registered and is not an error.
// Register and poll failures retry with a capped exponential backoff, and
// the process never exits before the env says done.
//
// Without MAKEFUN_ENV_URL there is no env to talk to, so the process serves
// on $PORT (default 8080) until killed — the local development mode the SDK
// runner is pointed at.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff after `attempt` consecutive failures: doubling from 250ms, capped at 2s. */
function backoff(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or another entry won (409). */
async function registerUntilAccepted(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register refused with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register refused')) throw error;
      // A network error or a retryable status: the env may still be starting.
    }
    await pause(backoff(attempt));
  }
}

/** Poll GET /done until the env answers {"done": true}; never return early. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: the trial is not over.
    }
    await pause(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  if (ENV_URL === '') {
    const port = Number.parseInt(process.env.PORT ?? '8080', 10);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve());
    });
    process.stdout.write(`[entry] dev mode: serving on port ${port}\n`);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await registerUntilAccepted(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  if (ENV_URL !== '') process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
