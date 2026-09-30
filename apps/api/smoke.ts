const api = process.env.API_URL ?? 'http://localhost:3000';

async function verifyTrialActionPath() {
  const message = `compose-smoke-${Date.now()}`;
  const createdResponse = await fetch(`${api}/api/trial-actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!createdResponse.ok) throw new Error(`POST failed: ${createdResponse.status}`);
  const created = (await createdResponse.json()) as { id: string; message: string };
  if (!created.id || created.message !== message) throw new Error('POST returned unexpected data');

  const listResponse = await fetch(`${api}/api/trial-actions`);
  if (!listResponse.ok) throw new Error(`GET failed: ${listResponse.status}`);
  const actions = (await listResponse.json()) as Array<{ id: string; message: string }>;
  if (!actions.some((action) => action.id === created.id && action.message === message)) {
    throw new Error('Created action was not returned by the list endpoint');
  }
  process.stdout.write(`Trial action persisted and retrievable: ${created.id}\n`);
}

void verifyTrialActionPath().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
