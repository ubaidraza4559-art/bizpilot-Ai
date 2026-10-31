// Vercel serverless entry point for BizPilot AI.
//
// DO NOT use a SQLite file here: Vercel's /tmp is per-instance and
// unshared, so accounts created on one instance vanish on the next
// (the signup -> dashboard error). Instead, server.js automatically
// uses JsonDb (lib/jsondb.js) when BLOB_READ_WRITE_TOKEN is present,
// persisting one JSON document to the private Vercel Blob store
// (bizpilot-ai-db) that every instance shares. The BLOB token is
// injected by Vercel from the linked Blob store — it is never stored
// in this repo.
// Set AUTH_SECRET in the Vercel project env vars; without it, sessions
// will not survive a restart.
const { app, dbReady } = require('../server.js');
module.exports = async (req, res) => {
  try { await dbReady; } catch {}
  return app(req, res);
};
