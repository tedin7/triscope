// `triscope list` — print the live element manifest from the running dev server.
export async function runList({ url = 'http://localhost:5173' } = {}) {
  const endpoint = `${url.replace(/\/$/, '')}/__manifest`;
  let res;
  try {
    res = await fetch(endpoint);
  } catch (err) {
    console.error(`Could not reach ${endpoint}. Is \`triscope dev\` running?`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${endpoint} returned ${res.status}`);
    process.exit(1);
  }
  const manifest = await res.json();
  if (manifest == null) {
    console.error('Dev server is up but no manifest has been posted yet. Load a lab page first.');
    process.exit(2);
  }
  console.log(JSON.stringify(manifest, null, 2));
}
