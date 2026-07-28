import {
  Activity,
  Award,
  Beer,
  Boxes,
  CalendarCheck,
  Crosshair,
  Crown,
  Flag,
  Flame,
  Gauge,
  Globe,
  Infinity as InfinityIcon,
  ListOrdered,
  Lock,
  Medal,
  Moon,
  Rocket,
  Skull,
  SlidersHorizontal,
  Swords,
  Target,
  Trophy,
  Undo2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Label, Panel } from './ui/primitives';
import type { AchievementState, AchievementTier } from '@scrapyard/shared';

/**
 * Icon keys come from the API as strings; resolve them here.
 * Keys must stay in sync with ACHIEVEMENTS in achievements.service.ts —
 * anything unmatched falls back to the trophy.
 */
const ICONS: Record<string, LucideIcon> = {
  flame: Flame,
  boxes: Boxes,
  crown: Crown,
  trophy: Trophy,
  zap: Zap,
  target: Target,
  gauge: Gauge,
  rocket: Rocket,
  'calendar-check': CalendarCheck,
  infinity: InfinityIcon,
  medal: Medal,
  swords: Swords,
  moon: Moon,
  undo: Undo2,
  globe: Globe,
  // Keys used by the new metrics, rules and specials. Anything still unmatched
  // falls back to the trophy below.
  beer: Beer,
  crosshair: Crosshair,
  skull: Skull,
  flag: Flag,
  activity: Activity,
  award: Award,
  'sliders-horizontal': SlidersHorizontal,
  'list-ordered': ListOrdered,
};

const TIER_COLOR: Record<AchievementTier, string> = {
  bronze: '#FF8A3D',
  silver: '#CFE3FF',
  gold: '#FFB020',
  plasma: '#00E5FF',
};

export function AchievementGrid({ achievements }: { achievements: AchievementState[] }) {
  const unlocked = achievements.filter((a) => a.unlocked);
  const locked = achievements.filter((a) => !a.unlocked);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="headline-cold font-display text-xl font-black uppercase sm:text-2xl">
          Achievements
        </h2>
        <p className="font-mono text-xs text-[var(--text-dim)]">
          {unlocked.length} / {achievements.length} unlocked
        </p>
      </div>

      {/* Overall completion bar. */}
      <div className="h-1.5 w-full overflow-hidden bg-white/5">
        <span
          className="block h-full transition-all duration-700"
          style={{
            width: `${(unlocked.length / Math.max(1, achievements.length)) * 100}%`,
            background: 'linear-gradient(90deg, #FF6A00, #FF2D95, #00E5FF)',
            boxShadow: '0 0 18px rgb(255 106 0 / 0.7)',
          }}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 3xl:grid-cols-4 4xl:grid-cols-5">
        {[...unlocked, ...locked].map((achievement) => (
          <AchievementCard key={achievement.id} achievement={achievement} />
        ))}
      </div>
    </div>
  );
}

function AchievementCard({ achievement }: { achievement: AchievementState }) {
  const Icon = ICONS[achievement.icon] ?? Trophy;
  const color = TIER_COLOR[achievement.tier];
  const { unlocked } = achievement;

  return (
    <Panel
      accent={color}
      tight
      lit={unlocked}
      className={`group relative overflow-hidden p-4 transition-all duration-300 ${
        unlocked ? 'hover:-translate-y-1' : 'opacity-60 hover:opacity-90'
      }`}
    >
      {/* Diagonal sheen sweeping across unlocked badges. */}
      {unlocked && (
        <span
          className="pointer-events-none absolute -inset-full opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{
            background: `linear-gradient(115deg, transparent 40%, ${color}33 50%, transparent 60%)`,
            animation: 'sheen 1.4s linear infinite',
          }}
        />
      )}

      <div className="relative flex items-start gap-3">
        <span
          className={`grid h-11 w-11 shrink-0 place-items-center ${unlocked ? 'ring-spin' : ''}`}
          style={{
            background: unlocked
              ? `radial-gradient(circle at 35% 25%, ${color}55, #0a0e1c 75%)`
              : 'rgb(255 255 255 / 0.03)',
            border: `1px solid ${unlocked ? color : 'var(--hairline)'}`,
            boxShadow: unlocked ? `0 0 22px -6px ${color}` : 'none',
            borderRadius: 4,
          }}
        >
          {unlocked ? (
            <Icon size={19} style={{ color }} />
          ) : (
            <Lock size={16} className="text-[var(--text-faint)]" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p
            className="truncate font-display text-[0.78rem] font-black uppercase tracking-wide"
            style={{
              color: unlocked ? '#fff' : 'var(--text-dim)',
              textShadow: unlocked ? `0 0 14px ${color}` : 'none',
            }}
          >
            {achievement.name}
          </p>
          <p className="mt-0.5 text-[0.7rem] leading-snug text-[var(--text-faint)]">
            {achievement.description}
          </p>
        </div>
      </div>

      {/* Progress toward the goal. */}
      <div className="relative mt-3.5">
        <div className="h-1 w-full overflow-hidden bg-white/[0.06]">
          <span
            className="block h-full transition-all duration-700"
            style={{
              width: `${Math.round(achievement.progress * 100)}%`,
              background: unlocked
                ? `linear-gradient(90deg, ${color}, #fff)`
                : `linear-gradient(90deg, ${color}88, ${color}33)`,
              boxShadow: unlocked ? `0 0 12px ${color}` : 'none',
            }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[0.6rem] text-[var(--text-faint)]">
            {achievement.progressLabel}
          </span>
          <Label className="shrink-0 !text-[0.48rem]" >{achievement.tier}</Label>
        </div>
      </div>

      <style>{`
        @keyframes sheen {
          from { transform: translateX(-30%); }
          to   { transform: translateX(30%); }
        }
      `}</style>
    </Panel>
  );
}

export default AchievementGrid;
