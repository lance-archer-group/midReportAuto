// trigger.js
const http = require('http');
const opts = {
  host: '127.0.0.1',
  port: 3889,
  path: '/run',
  method: 'POST',
  headers: { 'x-api-key': process.env.JOB_API_KEY || '' },
};
const req = http.request(opts, (res) => {
  res.resume();
  res.on('end', () => process.exit(res.statusCode === 202 ? 0 : 1));
});
req.on('error', () => process.exit(1));
req.end();
