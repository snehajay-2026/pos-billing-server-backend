const http = require('http');
const data = JSON.stringify({ email: 'test@gmail.com' });

const options = {
  hostname: '127.0.0.1',
  port: 4000,
  path: '/api/password-reset/request',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    console.log('STATUS', res.statusCode);
    console.log('HEADERS', JSON.stringify(res.headers, null, 2));
    console.log('BODY', body);
  });
});

req.on('error', (err) => {
  console.error('ERROR', err.message);
});

req.write(data);
req.end();
