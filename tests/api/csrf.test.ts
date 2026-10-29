import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

const form = { 'content-type': 'application/x-www-form-urlencoded' };

describe('changes from other websites', () => {
  it('can\'t be made with a plain HTML form, whatever the sign-in mode', async () => {
    const { app } = await makeApp({ auth: 'none' });
    // Only OAuth's token endpoint reads form posts.
    const r = await app.inject({ method: 'POST', url: '/api/v1/products', headers: form, payload: 'name=Planted' });
    expect(r.statusCode).toBe(415);
    const setup = await (await makeApp()).app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: form, payload: 'username=attacker&password=correct+horse' });
    expect(setup.statusCode).toBe(415);
  });

  it('are refused when the browser says they came from another site', async () => {
    const { app } = await makeApp({ auth: 'none' });
    const cross = await app.inject({ method: 'POST', url: '/api/v1/products', headers: { 'sec-fetch-site': 'cross-site' }, payload: { name: 'Planted' } });
    expect(cross.statusCode).toBe(403);
    const origin = await app.inject({ method: 'POST', url: '/api/v1/products', headers: { origin: 'https://evil.example', host: 'larder.local:8080' }, payload: { name: 'Planted' } });
    expect(origin.statusCode).toBe(403);
    const multipart = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { 'sec-fetch-site': 'same-site' }, payload: { username: 'a', password: 'correct horse' } });
    expect(multipart.statusCode).toBe(403);
    // Larder's own pages, scripts and apps are fine.
    expect((await app.inject({ method: 'POST', url: '/api/v1/products', headers: { 'sec-fetch-site': 'same-origin' }, payload: { name: 'Beans' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/products', headers: { origin: 'http://larder.local:8080', host: 'larder.local:8080' }, payload: { name: 'Peas' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Rice' } })).statusCode).toBe(200);
    // Reading is fine from anywhere (the browser keeps the answer from the other site).
    expect((await app.inject({ method: 'GET', url: '/api/v1/products', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(200);
  });

  it('pass with an access token or Larder\'s own header, which other sites can\'t send', async () => {
    const made = await makeApp();
    await made.call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    const token = (await made.call<{ token: string }>('POST', '/api/v1/auth/tokens', { name: 'browser tool' })).body.token;
    const r = await made.app.inject({ method: 'POST', url: '/api/v1/products', headers: { 'sec-fetch-site': 'cross-site', authorization: `Bearer ${token}` }, payload: { name: 'Beans' } });
    expect(r.statusCode).toBe(200);
  });
});
