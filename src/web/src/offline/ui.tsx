/**
 * Offline copies in the app: "Load data from" when Larder can't be reached,
 * the bar shown while a copy is open, and Settings → Offline copies.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ApiError } from '../apiError';
import { Icon } from '../icons';
import { savedText, sizeText } from '../format';
import { Loading, Sheet, Switch, useToast } from '../ui';
import { useOpenCopy } from './current';
import { dailyCopies, KEEP, leaveCopy, offlineSupport, saveCopy, setDailyCopies, showCopy } from './state';
import { listCopies, removeCopy, type CopyInfo } from './store';

export const COPIES_KEY = ['offline', 'copies'] as const;

/** The copies on this device, newest first. Not answered from a copy: they're on the device either way. */
export function useCopies() {
  return useQuery({ queryKey: COPIES_KEY, queryFn: listCopies, retry: false, staleTime: 0 });
}

const metaText = (c: CopyInfo) => [`${c.items} item${c.items === 1 ? '' : 's'}`, `${c.places} place${c.places === 1 ? '' : 's'}`, sizeText(c.bytes), c.auto ? 'saved automatically' : null].filter(Boolean).join(' · ');

function CopyRows({ copies, onOpen, onRemove, busy }: { copies: CopyInfo[]; onOpen: (c: CopyInfo) => void; onRemove?: (c: CopyInfo) => void; busy?: boolean }) {
  const open = useOpenCopy();
  return (
    <div className="list">
      {copies.map((c) => {
        const current = open?.info.id === c.id;
        return (
          <div className="item" key={c.id}>
            <span className="tile"><Icon name="clock" /></span>
            <button type="button" className="item-main copy-open" disabled={busy || current} onClick={() => onOpen(c)} aria-label={`Load the copy saved ${savedText(c.savedAt)}`}>
              <span className="item-name">{savedText(c.savedAt)}{current ? ' (open)' : ''}</span>
              <span className="item-meta">{metaText(c)}</span>
            </button>
            {onRemove && !current && <button type="button" className="iconbtn ghost" aria-label={`Remove the copy saved ${savedText(c.savedAt)}`} disabled={busy} onClick={() => onRemove(c)}><Icon name="trash" size="sm" /></button>}
          </div>
        );
      })}
    </div>
  );
}

function useShowCopy() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const show = async (c: CopyInfo) => {
    setBusy(true);
    try {
      await showCopy(c, qc);
    } catch (err) {
      toast({ text: err instanceof Error ? err.message : "That copy couldn't be opened.", error: true });
    } finally {
      setBusy(false);
    }
  };
  return { show, busy };
}

/** Instead of the app, when Larder can't be reached: try again, or load a saved copy. */
export function OfflineStart({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  const copies = useCopies();
  const { show, busy } = useShowCopy();
  const unreachable = !(error instanceof ApiError) || error.code === 'offline';
  return (
    <div className="login">
      <div className="card offline-start">
        <div className="row"><span className="mark"><Icon name="jar" /></span><h1 style={{ fontSize: 28 }}>Larder</h1></div>
        <div className="stack">
          <b>Can't reach Larder.</b>
          <p className="muted small" style={{ margin: 0 }}>{unreachable ? 'Check your connection and that the server is running.' : error.message}</p>
          <button type="button" className="btn" style={{ justifySelf: 'start' }} disabled={retrying} onClick={onRetry}>{retrying ? 'Trying…' : 'Try again'}</button>
        </div>
        <div className="section">
          <div className="label">Load data from</div>
          {copies.isLoading ? <Loading /> : copies.data?.length ? (
            <>
              <CopyRows copies={copies.data} onOpen={(c) => void show(c)} busy={busy} />
              <p className="small muted" style={{ margin: 0 }}>A copy shows what was in Larder when it was saved. You can look and search, but not change anything.</p>
            </>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>There are no copies saved on this device. When Larder is back, save one in Settings → Offline copies, or let Larder save one each day.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Across the top while a copy is open: when it's from, and the way back. */
export function CopyBar() {
  const open = useOpenCopy();
  const qc = useQueryClient();
  const toast = useToast();
  const [choosing, setChoosing] = useState(false);
  const [trying, setTrying] = useState(false);
  const copies = useCopies();
  const { show, busy } = useShowCopy();
  // Photos aren't in copies: one the phone hasn't kept would show as a broken picture, so it's left blank.
  useEffect(() => {
    if (!open) return;
    const blank = (e: Event) => {
      if (e.target instanceof HTMLImageElement) e.target.style.visibility = 'hidden';
    };
    document.addEventListener('error', blank, true);
    return () => document.removeEventListener('error', blank, true);
  }, [open]);
  if (!open) return null;
  const live = async () => {
    setTrying(true);
    try {
      await api.auth.liveStatus();
      setChoosing(false);
      await leaveCopy(qc);
    } catch (err) {
      toast({ text: err instanceof ApiError && err.code !== 'offline' ? err.message : 'Still can\'t reach Larder. Staying on the saved copy.', error: true });
    } finally {
      setTrying(false);
    }
  };
  return (
    <div className="copy-bar" role="status">
      <Icon name="clock" size="sm" />
      <span className="grow"><b>Saved copy</b> · {savedText(open.info.savedAt)} · read only</span>
      <button type="button" className="btn small" onClick={() => setChoosing(true)}>Change</button>
      {choosing && (
        <Sheet title="Load data from" onClose={() => setChoosing(false)}>
          <div className="stack">
            <button type="button" className="btn primary" disabled={trying} onClick={() => void live()}>{trying ? 'Trying…' : 'Back to the live Larder'}</button>
            {copies.data?.length ? <CopyRows copies={copies.data} onOpen={(c) => void show(c).then(() => setChoosing(false))} busy={busy} /> : null}
          </div>
        </Sheet>
      )}
    </div>
  );
}

const SUPPORT_TEXT: Record<string, string> = {
  ok: 'Larder is kept on this device, so it opens even with no connection. Then you can load one of these copies, search it and see where things are.',
  frame: "Copies saved here can only be opened while Home Assistant can be reached, because the Home Assistant app has to reach it before it shows Larder. To use Larder with no connection, open it at its own https address in your phone's browser, add it to your home screen, and keep copies there.",
  insecure: 'Phones only keep Larder for use with no connection when it is opened at an https address, and this one is http. Copies saved here can still be looked at while Larder can be reached.',
  unsupported: "This browser can't keep Larder for use with no connection. Copies saved here can still be looked at while Larder can be reached.",
};

/** Settings → Offline copies. */
export function OfflineSettings() {
  const copies = useCopies();
  const open = useOpenCopy();
  const qc = useQueryClient();
  const toast = useToast();
  const { show, busy: opening } = useShowCopy();
  const [daily, setDaily] = useState(dailyCopies);
  const [saving, setSaving] = useState(false);
  const support = offlineSupport();
  const save = async () => {
    setSaving(true);
    try {
      const c = await saveCopy(false);
      toast(`Saved a copy: ${c.items} item${c.items === 1 ? '' : 's'}, ${sizeText(c.bytes)}`);
    } catch (err) {
      toast({ text: err instanceof Error ? `The copy wasn't saved. ${err.message}` : "The copy wasn't saved.", error: true });
    } finally {
      setSaving(false);
      await qc.invalidateQueries({ queryKey: COPIES_KEY });
    }
  };
  const remove = async (c: CopyInfo) => {
    await removeCopy(c.id);
    await qc.invalidateQueries({ queryKey: COPIES_KEY });
    toast('Copy removed');
  };
  return (
    <div className="section">
      <div className="label">Offline copies</div>
      <p className="small muted" style={{ margin: 0 }}>{SUPPORT_TEXT[support]} The newest {KEEP} are kept. They stay on this device until you remove them or sign out.</p>
      {!open && (
        <div className="list">
          <div className="toggle">
            <span className="grow"><b>Save a copy each day</b><br /><span className="small muted">When you open Larder and the newest copy is over a day old.</span></span>
            <Switch checked={daily} label="Save a copy each day" onChange={(v) => { setDailyCopies(v); setDaily(v); }} />
          </div>
          <div className="toggle">
            <span className="grow"><b>Save a copy now</b><br /><span className="small muted">Everything Larder shows you: items, places, shopping lists, scenarios and recipes. Not photos.</span></span>
            <button type="button" className="btn small" disabled={saving} onClick={() => void save()}><Icon name="download" size="sm" />{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
      {copies.data?.length ? <CopyRows copies={copies.data} onOpen={(c) => void show(c)} onRemove={(c) => void remove(c)} busy={opening} /> : !copies.isLoading && <p className="small muted" style={{ margin: 0 }}>No copies on this device yet.</p>}
    </div>
  );
}
