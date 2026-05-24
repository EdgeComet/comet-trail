// GET /api/summary — total number of captured crawl rows.
// Reads the same D1 database the tracking worker writes to (binding: DB).
export async function onRequestGet({ env }) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM crawls').first();
  return Response.json({ total: row.total });
}
