import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Megaphone,
  Palette,
  Plus,
  Save,
  Search,
  Trash2,
  TriangleAlert,
  Trophy,
  Users as UsersIcon,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../state/AppStore';
import { ArthurShip } from '../components/arthur/ArthurShip';
import {
  ErrorPlate,
  Label,
  LoadingRig,
  NeonButton,
  Panel,
} from '../components/ui/primitives';
import type { ContentTypeDescriptor, Pun } from '@scrapyard/shared';

const ICONS: Record<string, LucideIcon> = {
  megaphone: Megaphone,
  trophy: Trophy,
  users: UsersIcon,
  palette: Palette,
  download: Download,
};

const ACCENTS: Record<string, string> = {
  puns: '#FF6A00',
  export: '#B6FF3C',
  achievements: '#FFB020',
  racers: '#00E5FF',
  theme: '#7C5CFF',
};

/**
 * Admin. Landing view is a searchable grid of content-type cards; picking one
 * opens its editor. Only `puns` is editable today — the others are visible but
 * marked read-only, which keeps the grid honest about what exists.
 */
export function AdminPage() {
  const { me } = useApp();
  const [types, setTypes] = useState<ContentTypeDescriptor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openType, setOpenType] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTypes(await api.admin.contentTypes());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load content types');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!types) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return types;
    return types.filter(
      (type) =>
        type.label.toLowerCase().includes(needle) ||
        type.description.toLowerCase().includes(needle) ||
        type.keywords.some((keyword) => keyword.includes(needle)),
    );
  }, [types, query]);

  if (me?.role !== 'admin') {
    return (
      <ErrorPlate message="This page is admin-only. Ask an admin to promote your account." />
    );
  }
  if (error) return <ErrorPlate message={error} onRetry={() => void load()} />;
  if (!types) return <LoadingRig label="Opening the workshop" />;

  // Editor view.
  if (openType === 'puns') {
    return <PunsEditor onBack={() => setOpenType(null)} />;
  }
  if (openType) {
    const type = types.find((candidate) => candidate.id === openType);
    return (
      <ReadOnlyPreview
        id={openType}
        label={type?.label ?? openType}
        onBack={() => setOpenType(null)}
      />
    );
  }

  // Grid view.
  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Label>Control room</Label>
          <h1 className="headline mt-1">Admin</h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--text-dim)]">
            Pick a card to edit content or run an action. Search jumps straight
            to what you need.
          </p>
        </div>
        <div className="hidden opacity-60 sm:block">
          <div className="animate-hover">
            <ArthurShip size={110} accent="#7C5CFF" />
          </div>
        </div>
      </div>

      {/* Search across content types. */}
      <div className="relative">
        <Search
          size={17}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
        />
        <input
          className="field !py-3 !pl-11 !text-base"
          placeholder="Search — puns, banner, export, backup, achievements, theme…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </div>

      {filtered.length === 0 ? (
        <Panel className="p-10 text-center">
          <p className="text-sm text-[var(--text-faint)]">
            No content type matches “{query}”.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 3xl:grid-cols-4">
          {filtered.map((type) =>
            type.id === 'export' ? (
              <ExportCard key={type.id} type={type} />
            ) : (
              <ContentCard key={type.id} type={type} onOpen={() => setOpenType(type.id)} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Shared card chrome so content cards and action cards stay visually identical. */
function CardBody({
  type,
  accent,
  badge,
  children,
}: {
  type: ContentTypeDescriptor;
  accent: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  const Icon = ICONS[type.icon] ?? Megaphone;

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <span
          className="grid h-12 w-12 shrink-0 place-items-center"
          style={{
            background: `radial-gradient(circle at 32% 24%, ${accent}44, #0a0e1c 76%)`,
            border: `1px solid ${accent}`,
            boxShadow: `0 0 24px -8px ${accent}`,
            borderRadius: 4,
          }}
        >
          <Icon size={21} style={{ color: accent }} />
        </span>

        <span className="flex flex-col items-end gap-1.5">
          <span
            className="stat-number text-2xl"
            style={{ color: '#fff', textShadow: `0 0 16px ${accent}` }}
          >
            {type.itemCount}
          </span>
          {badge ?? (
            <span className="text-[0.5rem] uppercase tracking-widest text-[var(--text-faint)]">
              {type.unit}
            </span>
          )}
        </span>
      </div>

      <h2
        className="mt-4 font-display text-sm font-black uppercase tracking-wide text-white"
        style={{ textShadow: `0 0 14px ${accent}` }}
      >
        {type.label}
      </h2>
      <p className="mt-1.5 text-[0.72rem] leading-snug text-[var(--text-faint)]">
        {type.description}
      </p>
      {children}
    </>
  );
}

function ContentCard({
  type,
  onOpen,
}: {
  type: ContentTypeDescriptor;
  onOpen: () => void;
}) {
  const accent = ACCENTS[type.id] ?? '#00E5FF';

  return (
    <button onClick={onOpen} className="group text-left">
      <Panel
        accent={accent}
        lit
        className="relative h-full overflow-hidden p-5 transition-all duration-300 group-hover:-translate-y-1"
      >
        <CardBody
          type={type}
          accent={accent}
          badge={
            !type.editable ? (
              <span className="flex items-center gap-1 text-[0.5rem] uppercase tracking-widest text-[var(--text-faint)]">
                <Lock size={9} /> read-only
              </span>
            ) : undefined
          }
        />
      </Panel>
    </button>
  );
}

/**
 * The export action card. Unlike the content cards it doesn't navigate — it
 * fires the download in place and reports the result on the card itself.
 */
function ExportCard({ type }: { type: ContentTypeDescriptor }) {
  const accent = ACCENTS.export;
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState<string | null>(null);

  const download = async () => {
    setState('working');
    setDetail(null);
    try {
      const { filename, bytes } = await api.admin.exportDatabase();
      setState('done');
      setDetail(`${filename} · ${formatBytes(bytes)}`);
      // Let the confirmation sit a while, then go back to idle.
      window.setTimeout(() => setState('idle'), 6000);
    } catch (caught) {
      setState('error');
      setDetail(caught instanceof Error ? caught.message : 'Export failed');
    }
  };

  const busy = state === 'working';

  return (
    <button onClick={() => void download()} disabled={busy} className="group text-left">
      <Panel
        accent={state === 'error' ? '#FF3B30' : accent}
        lit
        className={`relative h-full overflow-hidden p-5 transition-all duration-300 ${
          busy ? '' : 'group-hover:-translate-y-1'
        }`}
      >
        {/* Sweep across the card while the archive is being built. */}
        {busy && (
          <span
            className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
            style={{
              background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
              animation: 'export-sweep 1.1s linear infinite',
            }}
          />
        )}

        <CardBody
          type={type}
          accent={state === 'error' ? '#FF3B30' : accent}
          badge={
            <span
              className="flex items-center gap-1 text-[0.5rem] uppercase tracking-widest"
              style={{ color: accent }}
            >
              <Zap size={9} /> action
            </span>
          }
        >
          <div className="mt-4 flex items-center gap-2">
            <span
              className="inline-flex items-center gap-2 border px-2.5 py-1.5 font-display text-[0.6rem] font-bold uppercase tracking-[0.16em] transition"
              style={{
                borderColor: state === 'error' ? '#FF3B30' : accent,
                background: `${state === 'error' ? '#FF3B30' : accent}1a`,
                color: '#fff',
              }}
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : state === 'done' ? (
                <Check size={12} />
              ) : state === 'error' ? (
                <TriangleAlert size={12} />
              ) : (
                <Download size={12} />
              )}
              {busy
                ? 'Zipping…'
                : state === 'done'
                  ? 'Downloaded'
                  : state === 'error'
                    ? 'Retry'
                    : 'Download zip'}
            </span>
          </div>

          {detail && (
            <p
              className="mt-2 truncate font-mono text-[0.58rem]"
              style={{ color: state === 'error' ? '#FF3B30' : 'var(--text-faint)' }}
              title={detail}
            >
              {detail}
            </p>
          )}
        </CardBody>

        <style>{`
          @keyframes export-sweep {
            from { transform: translateX(-100%); }
            to   { transform: translateX(100%); }
          }
        `}</style>
      </Panel>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** The puns editor — create, edit inline, toggle, reorder, delete. */
function PunsEditor({ onBack }: { onBack: () => void }) {
  const { refreshPuns } = useApp();
  const [puns, setPuns] = useState<Pun[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const load = useCallback(async () => {
    try {
      setPuns(await api.admin.puns());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load puns');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Every mutation refreshes the banner too, so changes are visible at once.
   * Returns whether it succeeded — callers must check before clearing an input,
   * otherwise a rejected request silently discards what the user typed.
   */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      await refreshPuns();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createPun = async () => {
    if (await run(() => api.admin.createPun(draft))) setDraft('');
  };

  const saveEdit = async (id: string) => {
    if (await run(() => api.admin.updatePun(id, { text: editingText }))) setEditingId(null);
  };

  const move = (index: number, direction: -1 | 1) => {
    if (!puns) return;
    const target = index + direction;
    if (target < 0 || target >= puns.length) return;
    const next = [...puns];
    [next[index], next[target]] = [next[target], next[index]];
    setPuns(next);
    void run(() => api.admin.reorderPuns(next.map((pun) => pun.id)));
  };

  if (!puns) return <LoadingRig label="Loading puns" />;

  const enabledCount = puns.filter((pun) => pun.enabled).length;

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="flex items-center gap-2 font-display text-[0.62rem] font-bold uppercase tracking-[0.2em] text-[var(--text-dim)] transition hover:text-white"
      >
        <ArrowLeft size={14} /> All content types
      </button>

      <div>
        <Label>Banner Puns · {enabledCount} live of {puns.length}</Label>
        <h1 className="headline mt-1 text-3xl sm:text-5xl">Puns</h1>
        <p className="mt-2 max-w-xl text-sm text-[var(--text-dim)]">
          These roll across the top prompter, with Arthur spinning between each
          one. Order here is the order up there.
        </p>
      </div>

      {/* Add new. */}
      <Panel accent="#FF6A00" lit className="p-5">
        <Label className="mb-2">New pun</Label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            className="field flex-1"
            placeholder="Brakes are a rumour started by slow people."
            maxLength={160}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim().length >= 3) {
                void createPun();
              }
            }}
          />
          <NeonButton
            variant="primary"
            accent="#FF6A00"
            disabled={busy || draft.trim().length < 3}
            onClick={() => void createPun()}
          >
            <Plus size={15} strokeWidth={3} /> Add
          </NeonButton>
        </div>
        <p className="mt-2 font-mono text-[0.6rem] text-[var(--text-faint)]">
          {draft.length}/160
        </p>
      </Panel>

      {error && (
        <p className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      {/* List. */}
      <Panel accent="#00E5FF" className="divide-y divide-hairline/60 overflow-hidden">
        {puns.map((pun, index) => (
          <div
            key={pun.id}
            className={`flex items-center gap-3 px-3 py-2.5 transition-colors sm:px-4 ${
              pun.enabled ? '' : 'opacity-45'
            }`}
          >
            {/* Reorder. */}
            <span className="flex shrink-0 flex-col">
              <button
                className="px-1 text-[var(--text-faint)] transition hover:text-plasma disabled:opacity-20"
                disabled={index === 0 || busy}
                onClick={() => move(index, -1)}
                aria-label="Move up"
              >
                <ChevronUp size={14} />
              </button>
              <button
                className="px-1 text-[var(--text-faint)] transition hover:text-plasma disabled:opacity-20"
                disabled={index === puns.length - 1 || busy}
                onClick={() => move(index, 1)}
                aria-label="Move down"
              >
                <ChevronDown size={14} />
              </button>
            </span>

            <span className="w-6 shrink-0 text-center font-mono text-[0.65rem] text-[var(--text-faint)]">
              {index + 1}
            </span>

            {/* Text, inline-editable. */}
            {editingId === pun.id ? (
              <input
                className="field flex-1 !py-1.5"
                value={editingText}
                maxLength={160}
                autoFocus
                onChange={(event) => setEditingText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveEdit(pun.id);
                  if (event.key === 'Escape') setEditingId(null);
                }}
              />
            ) : (
              <button
                className="min-w-0 flex-1 truncate text-left text-[0.8rem] text-[var(--text)] transition hover:text-plasma"
                onClick={() => {
                  setEditingId(pun.id);
                  setEditingText(pun.text);
                }}
                title="Click to edit"
              >
                {pun.text}
              </button>
            )}

            {/* Actions. */}
            <span className="flex shrink-0 items-center gap-1">
              {editingId === pun.id ? (
                <button
                  className="p-1.5 text-toxic transition hover:scale-110"
                  disabled={busy}
                  onClick={() => void saveEdit(pun.id)}
                  aria-label="Save"
                >
                  <Save size={15} />
                </button>
              ) : (
                <button
                  className="p-1.5 text-[var(--text-dim)] transition hover:scale-110 hover:text-plasma"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.admin.updatePun(pun.id, { enabled: !pun.enabled }))
                  }
                  aria-label={pun.enabled ? 'Hide from banner' : 'Show in banner'}
                  title={pun.enabled ? 'Live — click to hide' : 'Hidden — click to show'}
                >
                  {pun.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
              )}
              <button
                className="p-1.5 text-[var(--text-dim)] transition hover:scale-110 hover:text-danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Delete this pun?\n\n“${pun.text}”`)) {
                    void run(() => api.admin.deletePun(pun.id));
                  }
                }}
                aria-label="Delete"
              >
                <Trash2 size={15} />
              </button>
            </span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

/** Read-only preview for content types that aren't editable yet. */
function ReadOnlyPreview({
  id,
  label,
  onBack,
}: {
  id: string;
  label: string;
  onBack: () => void;
}) {
  const [items, setItems] = useState<unknown[] | null>(null);

  useEffect(() => {
    void api.admin
      .preview(id)
      .then((result) => setItems(result.items))
      .catch(() => setItems([]));
  }, [id]);

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="flex items-center gap-2 font-display text-[0.62rem] font-bold uppercase tracking-[0.2em] text-[var(--text-dim)] transition hover:text-white"
      >
        <ArrowLeft size={14} /> All content types
      </button>

      <div>
        <Label>
          <span className="inline-flex items-center gap-1.5">
            <Lock size={10} /> Read-only
          </span>
        </Label>
        <h1 className="headline mt-1 text-3xl sm:text-5xl">{label}</h1>
        <p className="mt-2 max-w-xl text-sm text-[var(--text-dim)]">
          Defined in code for now. Wiring this into the editor is the next step
          when you need it.
        </p>
      </div>

      {items === null ? (
        <LoadingRig label="Loading" />
      ) : items.length === 0 ? (
        <Panel className="p-10 text-center">
          <p className="text-sm text-[var(--text-faint)]">Nothing to preview here.</p>
        </Panel>
      ) : (
        <Panel accent="#7C5CFF" className="overflow-hidden p-4">
          <pre className="no-scrollbar max-h-[60vh] overflow-auto font-mono text-[0.65rem] leading-relaxed text-[var(--text-dim)]">
            {JSON.stringify(items, null, 2)}
          </pre>
        </Panel>
      )}
    </div>
  );
}

export default AdminPage;
