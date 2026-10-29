/**
 * NFC tags on a product or place. Linking works by scanning: with the Home
 * Assistant app (its tag_scanned event reaches Larder through the
 * integration), or directly in Android Chrome, which can read tags itself.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ago } from '../format';
import { Icon } from '../icons';
import { useAction, useToast } from '../ui';

interface NdefRecord { recordType: string; data?: DataView }
interface NdefReadingEvent { serialNumber: string; message: { records: NdefRecord[] } }
interface NdefReader { scan(options?: { signal?: AbortSignal }): Promise<void>; onreading: ((e: NdefReadingEvent) => void) | null }

/** Tags written by the Home Assistant app hold https://www.home-assistant.io/tag/<id>; use the same id it reports. */
function tagIdFrom(e: NdefReadingEvent): string {
  for (const r of e.message.records) {
    if (r.recordType !== 'url' || !r.data) continue;
    const url = new TextDecoder().decode(r.data);
    const m = /home-assistant\.io\/tag\/([^/?#]+)/.exec(url);
    if (m) return decodeURIComponent(m[1]!);
  }
  return e.serialNumber;
}

export function NfcTags({ tags, productId, placeId }: { tags: string[]; productId?: string; placeId?: string }) {
  const [linking, setLinking] = useState(false);
  const [reading, setReading] = useState<AbortController | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const recent = useQuery({ queryKey: ['nfc', 'recent'], queryFn: api.nfc.recent, enabled: linking, refetchInterval: linking ? 10_000 : false });
  const waiting = (recent.data ?? []).filter((r) => r.kind === 'unknown');
  const canRead = typeof window !== 'undefined' && 'NDEFReader' in window;

  const link = (tagId: string) => run(() => api.nfc.link({ tagId, productId, placeId }), 'Tag linked').then((r) => r && setLinking(false));

  async function readHere() {
    const Reader = (window as unknown as { NDEFReader: new () => NdefReader }).NDEFReader;
    const controller = new AbortController();
    setReading(controller);
    try {
      const reader = new Reader();
      await reader.scan({ signal: controller.signal });
      reader.onreading = (e) => {
        controller.abort();
        setReading(null);
        void link(tagIdFrom(e));
      };
    } catch {
      setReading(null);
      toast({ text: "This phone couldn't start reading tags. Check NFC is on, or scan with the Home Assistant app.", error: true });
    }
  }

  return (
    <div className="section">
      <div className="label">NFC tags{tags.length ? ` · ${tags.length}` : ''} <button type="button" className="link" onClick={() => { setLinking(!linking); reading?.abort(); setReading(null); }}>{linking ? 'Cancel' : 'Link a tag'}</button></div>
      {tags.length > 0 && (
        <div className="list">
          {tags.map((t) => (
            <div className="item" key={t}>
              <span className="tile"><Icon name="nfc" /></span>
              <span className="item-main"><span className="item-name mono" style={{ fontSize: 13 }}>{t}</span></span>
              <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.nfc.unlink(t), 'Tag unlinked')}>Unlink</button>
            </div>
          ))}
        </div>
      )}
      {!tags.length && !linking && <p className="muted small">Stick a tag on it and scanning the tag opens it, or tells Home Assistant.</p>}
      {linking && (
        <div className="card pad stack">
          <p className="small">Scan the tag with the Home Assistant app on your phone. It appears here within a few seconds.</p>
          {canRead && (
            <button type="button" className="btn" disabled={!!reading} onClick={() => void readHere()}>
              <Icon name="nfc" size="sm" />{reading ? 'Hold the tag to the back of the phone…' : 'Read it with this phone'}
            </button>
          )}
          {waiting.map((r) => (
            <div className="item" key={r.tagId} style={{ padding: 0 }}>
              <span className="item-main"><span className="item-name mono" style={{ fontSize: 13 }}>{r.tagId}</span><span className="item-meta">Scanned {ago(r.at)}{r.device ? ` on ${r.device}` : ''}</span></span>
              <button type="button" className="btn small primary" disabled={busy} onClick={() => void link(r.tagId)}>Link</button>
            </div>
          ))}
          {!waiting.length && <p className="muted small">Waiting for a new tag…</p>}
        </div>
      )}
    </div>
  );
}
