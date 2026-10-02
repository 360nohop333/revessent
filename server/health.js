// Revessent /api/health — liveness probe for uptime checks (audit #67 ADD).
module.exports = async (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
};
