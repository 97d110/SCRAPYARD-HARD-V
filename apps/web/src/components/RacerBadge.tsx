import { Link } from 'react-router-dom';
import { Avatar } from './ui/primitives';

/**
 * A racer's avatar + name, always linking to their profile.
 *
 * The rule across the app: wherever a racer is *named* (not picked in a form),
 * their face shows next to the name and the whole thing is one click from their
 * page. Using this component everywhere keeps that consistent.
 *
 * `stopPropagation` so it stays independently clickable even when it sits
 * inside another link (a leaderboard row, say).
 */
export function RacerBadge({
  id,
  name,
  avatarUrl,
  accentColor,
  size = 18,
  className = '',
  title,
}: {
  id: string;
  name: string;
  avatarUrl?: string;
  accentColor?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <Link
      to={`/racer/${id}`}
      title={title ?? `View ${name}'s profile`}
      onClick={(event) => event.stopPropagation()}
      className={`inline-flex items-center gap-1.5 align-middle transition hover:text-plasma ${className}`}
    >
      <Avatar src={avatarUrl || undefined} name={name} size={size} accent={accentColor} />
      <span className="truncate">{name}</span>
    </Link>
  );
}

export default RacerBadge;
