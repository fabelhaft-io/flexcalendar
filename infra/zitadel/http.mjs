import { request as http } from 'node:http';
import { request as https } from 'node:https';

// Deliberately never follows redirects: credentials cannot escape to a Location.
export function request(
  url,
  { method = 'GET', body, token, ca, host, form } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = form
      ? new URLSearchParams(form).toString()
      : body === undefined
        ? undefined
        : JSON.stringify(body);
    const req = (target.protocol === 'https:' ? https : http)(
      target,
      {
        method,
        ca,
        timeout: 30_000,
        headers: {
          ...(host ? { host } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? {
                'content-type': form
                  ? 'application/x-www-form-urlencoded'
                  : 'application/json',
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            /* redirects have no JSON */
          }
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            json,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', () => reject(new Error('Zitadel connection failed')));
    if (payload) req.write(payload);
    req.end();
  });
}

export function successful(response, operation) {
  if (response.status < 200 || response.status >= 300) {
    // Responses can contain passwords, codes and tokens. Never include them.
    throw new Error(`${operation}: HTTP ${response.status}`);
  }
  return response.json;
}
