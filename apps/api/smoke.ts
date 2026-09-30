const api = process.env.API_URL ?? 'http://localhost:3000';

async function verifyAnonymousAdminRequestsAreDenied() {
  const writeResponse = await fetch(`${api}/api/admin/trial-actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'anonymous smoke request' }),
  });
  const readResponse = await fetch(`${api}/api/admin/trial-actions`);
  if (writeResponse.status !== 403 || readResponse.status !== 403) {
    throw new Error(`Expected anonymous admin requests to return 403; got POST ${writeResponse.status}, GET ${readResponse.status}`);
  }
  process.stdout.write('Anonymous admin reads and writes are denied.\n');
}

void verifyAnonymousAdminRequestsAreDenied().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
