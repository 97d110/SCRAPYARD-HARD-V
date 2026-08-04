import type { RaceColor } from '@scrapyard/shared';

/**
 * The four in-game car colours — a racer's car AND their colour throughout the
 * UI. There used to be a second free-hex `accentColor` for theming; two colours
 * on one profile read as the same setting twice, and only this one means
 * anything in the game.
 *
 * Duplicates across the roster are expected and allowed: four colours cannot go
 * around eight racers, so two people who both drive green look alike. That's the
 * accepted cost of the colour matching the car.
 *
 * ── Why this is its own file ────────────────────────────────────────────────
 *
 * These lived on `UsersService` first, which created a circular import the
 * moment `ScoreboardRepository` needed the default — that repository is a
 * constructor dependency OF `UsersService`, so the two files importing each
 * other left one of them half-initialised at load time. Nest surfaced it as
 * "can't resolve dependencies of the UsersService … at index [1]", which names
 * the symptom and not the cause.
 *
 * TypeScript compiles a cycle like that without complaint, and so does Vite, so
 * neither typecheck nor build catches it — only booting does. Constants with no
 * dependencies of their own belong in a leaf module precisely so they can't
 * create one.
 */
export const RACE_COLORS = ['blue', 'red', 'green', 'yellow'] as const;

/** Everyone has a colour. Green is simply the one nobody had to choose. */
export const DEFAULT_RACE_COLOR: RaceColor = 'green';
