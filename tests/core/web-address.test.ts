import { describe, expect, it } from 'vitest';
import { publicWebAddress } from '@larder/core';
import { makeCore } from '../helpers';

describe('publicWebAddress', () => {
  it('lets through https addresses on the public web', () => {
    expect(publicWebAddress('https://www.tesco.com/groceries/x?y=1')?.hostname).toBe('www.tesco.com');
    expect(publicWebAddress('https://images-eu.ssl-images-amazon.com/a.jpg')).not.toBeNull();
  });

  it('turns away the home network, other schemes and addresses with logins in them', () => {
    for (const bad of [
      'http://www.tesco.com/', 'ftp://example.com/x', 'file:///etc/passwd', 'not a link',
      'https://localhost/', 'https://homeassistant.local:8123/', 'https://router.lan/', 'https://nas.home.arpa/', 'https://printer/',
      'https://192.168.1.1/', 'https://10.0.0.5/', 'https://127.0.0.1/', 'https://8.8.8.8/', 'https://[::1]/', 'https://[fd00::1]/',
      'https://user:secret@example.com/',
    ]) expect(publicWebAddress(bad), bad).toBeNull();
  });
});

describe('lookup.savePhotoFromLink', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(32).fill(2)]);

  it('saves a photo from the public web, following redirects only there', async () => {
    const asked: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      if (url === 'https://cdn.example.com/a.jpg') return new Response(null, { status: 302, headers: { location: '/b.jpg' } });
      if (url === 'https://cdn.example.com/b.jpg') return new Response(JPEG);
      if (url === 'https://cdn.example.com/inside.jpg') return new Response(null, { status: 302, headers: { location: 'https://192.168.1.10/cam.jpg' } });
      if (url === 'https://cdn.example.com/page.html') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      throw new Error(`No network in tests (${url})`);
    }) as unknown as typeof fetch;
    const core = await makeCore({ fetch: fake });

    const id = await core.lookup.savePhotoFromLink('https://cdn.example.com/a.jpg', 'Sausages');
    expect(id).toBeTruthy();
    expect((await core.adapters.files.get(id!))?.contentType).toBe('image/jpeg');

    expect(await core.lookup.savePhotoFromLink('https://cdn.example.com/inside.jpg', 'x')).toBeNull();
    expect(await core.lookup.savePhotoFromLink('https://cdn.example.com/page.html', 'x')).toBeNull();
    expect(await core.lookup.savePhotoFromLink('https://192.168.1.10/cam.jpg', 'x')).toBeNull();
    expect(asked).not.toContain('https://192.168.1.10/cam.jpg');
  });
});
