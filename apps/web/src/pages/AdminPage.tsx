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
  Pencil,
  Plus,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Trophy,
  UserPlus,
  Users as UsersIcon,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  api,
  type CreateMetricInput,
  type CreateRuleInput,
  type UpdateRuleInput,
} from '../lib/api';
import { useApp } from '../state/AppStore';
import { ArthurShip } from '../components/arthur/ArthurShip';
import {
  Avatar,
  ErrorPlate,
  Label,
  LoadingRig,
  NeonButton,
  Panel,
  Segmented,
} from '../components/ui/primitives';
import type {
  AchievementRule,
  AchievementScope,
  AchievementTier,
  ContentTypeDescriptor,
  FormulaTerm,
  MetricAggregation,
  MetricDef,
  PublicUser,
  Pun,
} from '@scrapyard/shared';

const ICONS: Record<string, LucideIcon> = {
  megaphone: Megaphone,
  trophy: Trophy,
  users: UsersIcon,
  'user-plus': UserPlus,
  palette: Palette,
  download: Download,
  'sliders-horizontal': SlidersHorizontal,
};

const ACCENTS: Record<string, string> = {
  puns: '#FF6A00',
  crew: '#FF2D95',
  export: '#B6FF3C',
  achievements: '#FFB020',
  metrics: '#7DF9FF',
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
  if (openType === 'crew') {
    return <CrewEditor onBack={() => setOpenType(null)} />;
  }
  if (openType === 'metrics') {
    return <MetricsEditor onBack={() => setOpenType(null)} />;
  }
  if (openType === 'achievements') {
    return <AchievementsEditor onBack={() => setOpenType(null)} />;
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
/**
 * Crew roster editor.
 *
 * The point of this screen: a teammate does not have to sign in before the
 * crew can score them. An admin adds an email, the seat appears on every
 * leaderboard immediately, and the first time that person signs in with Google
 * they inherit the seat and everything it has won.
 *
 * Unclaimed seats are shown first and marked, because that list is a to-do:
 * anyone still on it hasn't logged in yet.
 */
function CrewEditor({ onBack }: { onBack: () => void }) {
  const { users, refreshUsers } = useApp();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const unclaimed = users.filter((user) => !user.claimed);
  const claimed = users.filter((user) => user.claimed);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.admin.createRacer(email.trim(), displayName.trim());
      await refreshUsers();
      // Only clear on success — a rejected request must not eat what they typed.
      setEmail('');
      setDisplayName('');
      setAdded(created.displayName);
      window.setTimeout(() => setAdded(null), 5000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that racer');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.admin.deleteRacer(id);
      await refreshUsers();
      setConfirmingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not remove that racer');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    !busy && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && displayName.trim().length >= 2;

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
          Crew Roster · {claimed.length} signed in
          {unclaimed.length > 0 ? ` · ${unclaimed.length} awaiting first login` : ''}
        </Label>
        <h1 className="headline mt-1 text-3xl sm:text-5xl">Crew</h1>
        <p className="mt-2 max-w-xl text-sm text-[var(--text-dim)]">
          Add a teammate by email and they can be scored right away — no need to
          wait for them to join. When they first sign in with Google, that
          account links to the seat and keeps every win it has already earned.
        </p>
      </div>

      {/* Add new. */}
      <Panel accent={ACCENTS.crew} lit className="p-5">
        <Label className="mb-2">New racer</Label>
        <div className="flex flex-col gap-3 lg:flex-row">
          <input
            className="field flex-1"
            type="email"
            placeholder="teammate@cytactic.com"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) void create();
            }}
            autoFocus
          />
          <input
            className="field flex-1"
            placeholder="Name on the leaderboard"
            maxLength={40}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) void create();
            }}
          />
          <NeonButton accent={ACCENTS.crew} disabled={!canSubmit} onClick={() => void create()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Add racer
          </NeonButton>
        </div>

        <p className="mt-2.5 text-[0.68rem] text-[var(--text-faint)]">
          The address must be on the allowed sign-in domain, otherwise nobody
          could ever claim the seat. They can rename themselves once they join.
        </p>

        {added && (
          <p className="mt-3 flex items-center gap-2 text-[0.72rem] text-[var(--ok,#B6FF3C)]">
            <Check size={13} /> {added} added — they can be scored now.
          </p>
        )}
        {error && (
          <p className="mt-3 flex items-center gap-2 text-[0.72rem] text-[#FF6B6B]">
            <TriangleAlert size={13} /> {error}
          </p>
        )}
      </Panel>

      {unclaimed.length > 0 && (
        <div className="space-y-2.5">
          <Label>Awaiting first login</Label>
          {unclaimed.map((user) => (
            <CrewRow
              key={user.id}
              user={user}
              busy={busy}
              confirming={confirmingId === user.id}
              onConfirm={() => setConfirmingId(user.id)}
              onCancel={() => setConfirmingId(null)}
              onDelete={() => void remove(user.id)}
            />
          ))}
        </div>
      )}

      <div className="space-y-2.5">
        <Label>Signed in</Label>
        {claimed.length === 0 ? (
          <Panel className="p-8 text-center">
            <p className="text-sm text-[var(--text-faint)]">Nobody has signed in yet.</p>
          </Panel>
        ) : (
          claimed.map((user) => <CrewRow key={user.id} user={user} busy={busy} />)
        )}
      </div>
    </div>
  );
}

/**
 * One roster line. Delete is only offered for an unclaimed seat, and only
 * behind a confirm — the server refuses anything else anyway, but an
 * unreachable button is a clearer statement of the rule than an error toast.
 */
function CrewRow({
  user,
  busy,
  confirming,
  onConfirm,
  onCancel,
  onDelete,
}: {
  user: PublicUser;
  busy: boolean;
  confirming?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
}) {
  const deletable = !user.claimed && user.scores.allTime === 0 && onConfirm;

  return (
    <Panel
      accent={user.accentColor}
      className={`flex flex-wrap items-center gap-3 p-3.5 ${user.claimed ? '' : 'opacity-90'}`}
    >
      <Avatar
        src={user.avatarUrl || undefined}
        name={user.displayName}
        accent={user.accentColor}
        size={36}
      />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-display text-[0.82rem] font-bold text-white">
            {user.displayName}
          </span>
          {user.role === 'admin' && (
            <span className="text-[0.5rem] uppercase tracking-widest text-[var(--text-faint)]">
              admin
            </span>
          )}
          {!user.claimed && (
            <span
              className="rounded-sm px-1.5 py-0.5 text-[0.5rem] uppercase tracking-widest"
              style={{ color: ACCENTS.crew, border: `1px solid ${ACCENTS.crew}55` }}
            >
              unclaimed
            </span>
          )}
        </span>
        <span className="block truncate text-[0.68rem] text-[var(--text-faint)]">
          {user.email}
        </span>
      </span>

      <span className="stat-number text-lg text-white">{user.scores.allTime}</span>

      {deletable &&
        (confirming ? (
          <span className="flex items-center gap-1.5">
            <NeonButton accent="#FF3B30" disabled={busy} onClick={onDelete}>
              <Trash2 size={13} /> Remove
            </NeonButton>
            <button
              onClick={onCancel}
              className="px-2 text-[0.62rem] uppercase tracking-widest text-[var(--text-faint)] transition hover:text-white"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={onConfirm}
            disabled={busy}
            aria-label={`Remove ${user.displayName}`}
            className="p-2 text-[var(--text-faint)] transition hover:text-[#FF3B30]"
          >
            <Trash2 size={15} />
          </button>
        ))}
    </Panel>
  );
}

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

/** Back link shared by the editor screens. */
function EditorBack({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="flex items-center gap-2 font-display text-[0.62rem] font-bold uppercase tracking-[0.2em] text-[var(--text-dim)] transition hover:text-white"
    >
      <ArrowLeft size={14} /> All content types
    </button>
  );
}

const AGGREGATION_OPTIONS: Array<{ value: MetricAggregation; label: string; hint?: string }> = [
  { value: 'sum', label: 'Sum', hint: 'total' },
  { value: 'max', label: 'Max', hint: 'best race' },
  { value: 'avg', label: 'Avg', hint: 'per race' },
  { value: 'last', label: 'Last', hint: 'latest' },
];

/**
 * Metrics editor. Everything a board can sort by is a metric: the built-in
 * derived ones (points, wins, …) are read-only; admins add captured metrics
 * (a number logged per racer per race) and formula metrics (a weighted combo of
 * other metrics — a scoring system). Toggling one off hides its column
 * everywhere without deleting the data.
 */
function MetricsEditor({ onBack }: { onBack: () => void }) {
  const [metrics, setMetrics] = useState<MetricDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [kind, setKind] = useState<'captured' | 'formula'>('captured');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [unit, setUnit] = useState('');
  const [icon, setIcon] = useState('');
  const [aggregation, setAggregation] = useState<MetricAggregation>('sum');
  const [terms, setTerms] = useState<FormulaTerm[]>([{ metricId: 'wins', weight: 1 }]);

  const load = useCallback(async () => {
    try {
      setMetrics(await api.admin.metrics.list());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load metrics');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const referenceable = (metrics ?? []).filter((metric) => metric.kind !== 'formula');

  const create = async () => {
    const base = { id: id.trim(), label: label.trim(), icon: icon.trim() || undefined, unit: unit.trim() || undefined };
    const payload: CreateMetricInput =
      kind === 'captured'
        ? { ...base, kind, aggregation }
        : { ...base, kind, formula: terms.filter((term) => term.metricId) };
    if (
      await run(() => api.admin.metrics.create(payload))
    ) {
      setId('');
      setLabel('');
      setUnit('');
      setIcon('');
      setTerms([{ metricId: 'wins', weight: 1 }]);
    }
  };

  if (!metrics) return <LoadingRig label="Loading metrics" />;

  const canCreate =
    !busy &&
    /^[a-z][a-z0-9_]{1,30}$/.test(id.trim()) &&
    label.trim().length >= 1 &&
    (kind === 'captured' || terms.some((term) => term.metricId));

  return (
    <div className="space-y-6">
      <EditorBack onBack={onBack} />

      <div>
        <Label>Metrics &amp; Scoring · {metrics.length} defined</Label>
        <h1 className="headline mt-1 text-3xl sm:text-5xl">Metrics</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--text-dim)]">
          Every metric is a sortable column on all three boards and something an
          achievement can key off. Built-ins are fixed; add your own captured
          stats and formula scoring systems below.
        </p>
      </div>

      {/* Create. */}
      <Panel accent={ACCENTS.metrics} lit className="space-y-4 p-5">
        <Segmented<'captured' | 'formula'>
          value={kind}
          onChange={setKind}
          accent={ACCENTS.metrics}
          options={[
            { value: 'captured', label: 'Captured stat', hint: 'logged per race' },
            { value: 'formula', label: 'Formula', hint: 'combine metrics' },
          ]}
        />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input className="field" placeholder="id — e.g. kills" maxLength={31} value={id} onChange={(e) => setId(e.target.value.toLowerCase())} />
          <input className="field" placeholder="Label — e.g. Kills" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className="field" placeholder="Unit — e.g. kills" maxLength={16} value={unit} onChange={(e) => setUnit(e.target.value)} />
          <input className="field" placeholder="Icon — e.g. crosshair" maxLength={40} value={icon} onChange={(e) => setIcon(e.target.value)} />
        </div>

        {kind === 'captured' ? (
          <div>
            <Label className="mb-1.5">Roll-up across races</Label>
            <Segmented<MetricAggregation>
              value={aggregation}
              onChange={setAggregation}
              accent={ACCENTS.metrics}
              options={AGGREGATION_OPTIONS}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Formula — weight × metric, summed</Label>
            {terms.map((term, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  className="field w-24 !py-1.5"
                  type="number"
                  step="0.5"
                  value={term.weight}
                  onChange={(e) => {
                    const next = [...terms];
                    next[index] = { ...term, weight: Number(e.target.value) };
                    setTerms(next);
                  }}
                />
                <span className="text-[var(--text-faint)]">×</span>
                <select
                  className="field flex-1 !py-1.5"
                  value={term.metricId}
                  onChange={(e) => {
                    const next = [...terms];
                    next[index] = { ...term, metricId: e.target.value };
                    setTerms(next);
                  }}
                >
                  {referenceable.map((metric) => (
                    <option key={metric.id} value={metric.id}>
                      {metric.label}
                    </option>
                  ))}
                </select>
                <button
                  className="p-1.5 text-[var(--text-faint)] transition hover:text-danger disabled:opacity-30"
                  disabled={terms.length <= 1}
                  onClick={() => setTerms(terms.filter((_, i) => i !== index))}
                  aria-label="Remove term"
                >
                  <X size={15} />
                </button>
              </div>
            ))}
            <button
              className="flex items-center gap-1.5 text-[0.68rem] uppercase tracking-widest text-[var(--text-dim)] transition hover:text-white"
              onClick={() => setTerms([...terms, { metricId: referenceable[0]?.id ?? 'wins', weight: 1 }])}
            >
              <Plus size={13} /> Add term
            </button>
          </div>
        )}

        <div className="flex justify-end">
          <NeonButton accent={ACCENTS.metrics} disabled={!canCreate} onClick={() => void create()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add metric
          </NeonButton>
        </div>
      </Panel>

      {error && (
        <p className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      )}

      {/* List. */}
      <Panel accent="#00E5FF" className="divide-y divide-hairline/60 overflow-hidden">
        {metrics.map((metric) => (
          <div key={metric.id} className={`flex items-center gap-3 px-4 py-3 ${metric.enabled ? '' : 'opacity-45'}`}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-display text-[0.82rem] font-bold uppercase tracking-wide text-white">
                  {metric.label}
                </span>
                <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-[0.5rem] uppercase tracking-widest text-[var(--text-faint)]">
                  {metric.kind}
                </span>
                {metric.builtin && (
                  <span className="flex items-center gap-1 text-[0.5rem] uppercase tracking-widest text-[var(--text-faint)]">
                    <Lock size={9} /> built-in
                  </span>
                )}
              </span>
              <span className="block truncate font-mono text-[0.62rem] text-[var(--text-faint)]">
                {metric.id}
                {metric.unit ? ` · ${metric.unit}` : ''}
                {metric.kind === 'captured' ? ` · ${metric.aggregation}` : ''}
                {metric.kind === 'formula' && metric.formula
                  ? ` · ${metric.formula.map((t) => `${t.weight}×${t.metricId}`).join(' + ')}`
                  : ''}
              </span>
            </span>

            {!metric.builtin && (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  className="p-1.5 text-[var(--text-dim)] transition hover:scale-110 hover:text-plasma"
                  disabled={busy}
                  onClick={() => void run(() => api.admin.metrics.update(metric.id, { enabled: !metric.enabled }))}
                  aria-label={metric.enabled ? 'Disable' : 'Enable'}
                  title={metric.enabled ? 'Shown — click to hide' : 'Hidden — click to show'}
                >
                  {metric.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
                <button
                  className="p-1.5 text-[var(--text-dim)] transition hover:scale-110 hover:text-danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete metric “${metric.label}”?`)) {
                      void run(() => api.admin.metrics.remove(metric.id));
                    }
                  }}
                  aria-label="Delete"
                >
                  <Trash2 size={15} />
                </button>
              </span>
            )}
          </div>
        ))}
      </Panel>
    </div>
  );
}

const TIER_OPTIONS: Array<{ value: AchievementTier; label: string }> = [
  { value: 'bronze', label: 'Bronze' },
  { value: 'silver', label: 'Silver' },
  { value: 'gold', label: 'Gold' },
  { value: 'plasma', label: 'Plasma' },
];

const SCOPE_OPTIONS: Array<{ value: AchievementScope; label: string; hint?: string }> = [
  { value: 'all-time', label: 'All-time', hint: 'total' },
  { value: 'daily', label: 'Best day', hint: 'single day' },
  { value: 'monthly', label: 'Best month', hint: 'single month' },
  { value: 'game', label: 'Single race', hint: 'one race' },
];

/**
 * Achievement rules editor. A rule unlocks when a metric reaches a threshold
 * within a scope — that covers the win tiers, N-in-a-day badges, points
 * milestones and any custom metric. The coded specials (Happy Hour,
 * Back-to-Back, streaks) aren't rules and don't appear here.
 */
function AchievementsEditor({ onBack }: { onBack: () => void }) {
  const [rules, setRules] = useState<AchievementRule[] | null>(null);
  const [metrics, setMetrics] = useState<MetricDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tier, setTier] = useState<AchievementTier>('bronze');
  const [icon, setIcon] = useState('award');
  const [metricId, setMetricId] = useState('wins');
  const [scope, setScope] = useState<AchievementScope>('all-time');
  const [threshold, setThreshold] = useState(1);

  const load = useCallback(async () => {
    try {
      const [ruleList, metricList] = await Promise.all([
        api.admin.achievementRules.list(),
        api.admin.metrics.list(),
      ]);
      setRules(ruleList);
      setMetrics(metricList);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load achievements');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setTier('bronze');
    setIcon('award');
    setMetricId('wins');
    setScope('all-time');
    setThreshold(1);
  };

  const startEdit = (rule: AchievementRule) => {
    setEditingId(rule.id);
    setName(rule.name);
    setDescription(rule.description);
    setTier(rule.tier);
    setIcon(rule.icon);
    setMetricId(rule.metricId);
    setScope(rule.scope);
    setThreshold(rule.threshold);
  };

  const submit = async () => {
    const ok = editingId
      ? await run(() => {
          const patch: UpdateRuleInput = { name, description, tier, icon, metricId, scope, threshold };
          return api.admin.achievementRules.update(editingId, patch);
        })
      : await run(() => {
          const payload: CreateRuleInput = {
            name,
            description: description.trim() || undefined,
            tier,
            icon,
            metricId,
            scope,
            threshold,
          };
          return api.admin.achievementRules.create(payload);
        });
    if (ok) resetForm();
  };

  if (!rules || !metrics) return <LoadingRig label="Loading achievements" />;

  const canSubmit = !busy && name.trim().length >= 1 && threshold > 0;
  const metricLabel = (mid: string) => metrics.find((m) => m.id === mid)?.label ?? mid;

  return (
    <div className="space-y-6">
      <EditorBack onBack={onBack} />

      <div>
        <Label>Achievements · {rules.length} rules</Label>
        <h1 className="headline mt-1 text-3xl sm:text-5xl">Achievements</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--text-dim)]">
          A rule fires when a metric reaches a threshold within a scope. Time-
          and streak-based badges (Happy Hour, Back-to-Back, day streaks) are
          built in and evaluated in code.
        </p>
      </div>

      {/* Create / edit. */}
      <Panel accent={ACCENTS.achievements} lit className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <Label>{editingId ? 'Edit rule' : 'New rule'}</Label>
          {editingId && (
            <button
              onClick={resetForm}
              className="flex items-center gap-1 text-[0.62rem] uppercase tracking-widest text-[var(--text-faint)] transition hover:text-white"
            >
              <X size={12} /> Cancel edit
            </button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <input className="field" placeholder="Name — e.g. Sharpshooter" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          <input className="field" placeholder="Icon — e.g. crosshair" maxLength={40} value={icon} onChange={(e) => setIcon(e.target.value)} />
        </div>
        <input className="field" placeholder="Description (optional)" maxLength={160} value={description} onChange={(e) => setDescription(e.target.value)} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <Label className="mb-1.5">Metric</Label>
            <select className="field" value={metricId} onChange={(e) => setMetricId(e.target.value)}>
              {metrics.map((metric) => (
                <option key={metric.id} value={metric.id}>
                  {metric.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <Label className="mb-1.5">Threshold</Label>
            <input className="field" type="number" min="1" step="1" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
          <div>
            <Label className="mb-1.5">Tier</Label>
            <Segmented<AchievementTier> value={tier} onChange={setTier} accent={ACCENTS.achievements} options={TIER_OPTIONS} />
          </div>
        </div>

        <div>
          <Label className="mb-1.5">Scope</Label>
          <Segmented<AchievementScope> value={scope} onChange={setScope} accent={ACCENTS.achievements} options={SCOPE_OPTIONS} />
        </div>

        <div className="flex justify-end">
          <NeonButton accent={ACCENTS.achievements} disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : editingId ? <Save size={15} /> : <Plus size={15} />}
            {editingId ? 'Save rule' : 'Add rule'}
          </NeonButton>
        </div>
      </Panel>

      {error && (
        <p className="border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      )}

      {/* List. */}
      <Panel accent="#00E5FF" className="divide-y divide-hairline/60 overflow-hidden">
        {rules.map((rule) => (
          <div key={rule.id} className={`flex items-center gap-3 px-4 py-3 ${rule.enabled ? '' : 'opacity-45'}`}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-display text-[0.82rem] font-bold uppercase tracking-wide text-white">
                  {rule.name}
                </span>
                <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-[0.5rem] uppercase tracking-widest text-[var(--text-faint)]">
                  {rule.tier}
                </span>
              </span>
              <span className="block truncate font-mono text-[0.62rem] text-[var(--text-faint)]">
                {metricLabel(rule.metricId)} ≥ {rule.threshold} · {rule.scope}
              </span>
            </span>

            <span className="flex shrink-0 items-center gap-1">
              <button
                className="p-1.5 text-[var(--text-dim)] transition hover:scale-110 hover:text-plasma"
                disabled={busy}
                onClick={() => startEdit(rule)}
                aria-label="Edit"
              >
                <Pencil size={15} />
              </button>
              <button
                className="p-1.5 text-[var(--text-dim)] transition hover:scale-110 hover:text-plasma"
                disabled={busy}
                onClick={() => void run(() => api.admin.achievementRules.update(rule.id, { enabled: !rule.enabled }))}
                aria-label={rule.enabled ? 'Disable' : 'Enable'}
              >
                {rule.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
              <button
                className="p-1.5 text-[var(--text-dim)] transition hover:scale-110 hover:text-danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Delete achievement “${rule.name}”?`)) {
                    void run(() => api.admin.achievementRules.remove(rule.id));
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

export default AdminPage;
