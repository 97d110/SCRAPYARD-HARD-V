import { arthurSvg } from './arthur.svg';
import { LoginBackground } from './login-background';

/**
 * The login page, rendered by the server.
 *
 * Deliberately a single self-contained HTML string: no React, no bundle, no
 * build step. That's the point of the split — an unauthenticated visitor gets
 * this page and nothing else, so the application bundle is never delivered to
 * anyone without a session.
 *
 * It still has to *look* like Scrapyard, so the design tokens from
 * apps/web/src/index.css are mirrored inline here. Keep them in sync.
 *
 * ── Background layering, bottom to top ──────────────────────────────────────
 *   0  poster still         instant paint, so there's never a black flash
 *   1  video / YT embed     fades in once it's actually playing
 *   2  dim + colour grade   the contrast pass: darkens and cools the footage
 *   3  vignette             pulls the corners down, focuses the centre
 *   4  grid floor + horizon the Scrapyard furniture, now sitting *on* the video
 *   5  content             lifted off the stack by drop shadow + rim highlight
 */
export interface LoginPageOptions {
  /** Domains permitted to sign in, e.g. ['cytactic.com']. */
  allowedDomains: string[];
  /** Message from a rejected sign-in attempt, if any. */
  error?: string;
  /** Where the Google flow starts. */
  loginUrl: string;
  background: LoginBackground;
}

/** Escape untrusted text before interpolating into HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const GOOGLE_MARK = `
<svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#FFC107" d="M43.6 20.1H24v7.9h11.3C33.7 32.9 29.3 36 24 36a12 12 0 1 1 0-24c3 0 5.8 1.1 7.9 3l5.6-5.6A20 20 0 1 0 24 44c11 0 20-8 20-20 0-1.3-.1-2.6-.4-3.9z"/>
  <path fill="#FF3D00" d="M6.3 14.7l6.5 4.8A12 12 0 0 1 24 12c3 0 5.8 1.1 7.9 3l5.6-5.6A20 20 0 0 0 6.3 14.7z"/>
  <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 12.7 28l-6.4 5A20 20 0 0 0 24 44z"/>
  <path fill="#1976D2" d="M43.6 20.1H24v7.9h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2c3.6-3.3 6.6-8.4 6.6-14.8 0-1.3-.1-2.6-.4-3.9z"/>
</svg>`.trim();

/** The media layer — a local <video>, a YouTube iframe, or nothing. */
function renderBackdrop(background: LoginBackground): string {
  if (background.kind === 'none') return '';

  const poster =
    background.posterUrl
      ? `<div class="bg-poster" style="background-image:url('${esc(background.posterUrl)}')"></div>`
      : '';

  if (background.kind === 'file') {
    return `
    <div class="bg" aria-hidden="true">
      ${poster}
      <video class="bg-media" autoplay muted loop playsinline preload="auto"
             ${background.posterUrl ? `poster="${esc(background.posterUrl)}"` : ''}>
        <source src="${esc(background.videoUrl)}" type="${esc(background.mimeType)}">
      </video>
    </div>`;
  }

  /*
   * YouTube background notes:
   *  - loop=1 only works in combination with playlist=<same id>
   *  - controls/branding are cropped by overscaling the iframe past the viewport
   *  - pointer-events:none means it can never be clicked or paused
   *  - it starts hidden and is revealed by script, so a blocked embed leaves the
   *    poster + grid rather than a black rectangle
   */
  const params = [
    'autoplay=1',
    'mute=1',
    'loop=1',
    `playlist=${background.videoId}`,
    'controls=0',
    'modestbranding=1',
    'playsinline=1',
    'rel=0',
    'disablekb=1',
    'fs=0',
    'iv_load_policy=3',
    'cc_load_policy=0',
  ].join('&');

  return `
    <div class="bg" aria-hidden="true">
      ${poster}
      <iframe class="bg-media bg-embed" id="bgEmbed" tabindex="-1"
              title="Background footage"
              src="https://www.youtube-nocookie.com/embed/${background.videoId}?${params}"
              allow="autoplay; encrypted-media" frameborder="0"></iframe>
    </div>`;
}

export function renderLoginPage({
  allowedDomains,
  error,
  loginUrl,
  background,
}: LoginPageOptions): string {
  const domainList = allowedDomains
    .map((domain) => `<span class="mono">@${esc(domain)}</span>`)
    .join(' / ');

  const hasVideo = background.kind !== 'none';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#04050c">
<meta name="robots" content="noindex, nofollow">
<title>Scrapyard — Sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Chakra+Petch:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cellipse cx='16' cy='19' rx='13' ry='5' fill='%2300E5FF'/%3E%3Cellipse cx='16' cy='17' rx='13' ry='5' fill='%23161c33'/%3E%3Ccircle cx='16' cy='12' r='6' fill='%23FF6A00'/%3E%3C/svg%3E">
<style>
  :root{
    --void:#04050c; --panel:#0d1122; --hairline:#222a48;
    --blaze:#ff6a00; --blaze-bright:#ffb020; --plasma:#00e5ff;
    --magenta:#ff2d95; --toxic:#b6ff3c;
    --text:#e8edff; --text-dim:#a3aed2; --text-faint:#6b769a;
    --danger:#ff5f57;
    color-scheme:dark;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{min-height:100%}
  body{
    background:var(--void);
    color:var(--text);
    font-family:'Chakra Petch',ui-sans-serif,system-ui,sans-serif;
    display:grid; place-items:center; padding:2.5rem 1rem;
    min-height:100vh; min-height:100dvh; overflow-x:hidden;
    -webkit-font-smoothing:antialiased;
  }

  /* ── Layer 0-1: the footage ────────────────────────────────────────────── */
  .bg{position:fixed; inset:0; z-index:0; overflow:hidden; background:#04050c}
  .bg-poster{
    position:absolute; inset:0;
    background-size:cover; background-position:center;
    /* Slight blur + desaturation so the still doesn't fight the panel while
       the video is still buffering. */
    filter:saturate(.85) blur(2px); transform:scale(1.04);
  }
  .bg-media{
    position:absolute; top:50%; left:50%;
    /* Cover the viewport at 16:9 whichever way it's shaped, then overscale to
       crop the letterbox and any embedded branding at the edges. */
    width:max(100vw, 177.78vh); height:max(100vh, 56.25vw);
    transform:translate(-50%,-50%) scale(1.32);
    border:0; pointer-events:none; object-fit:cover;
  }
  .bg-embed{opacity:0; transition:opacity 1.2s ease}
  .bg-embed.ready{opacity:1}
  video.bg-media{opacity:0; transition:opacity 1.2s ease}
  video.bg-media.ready{opacity:1}

  /* ── Layer 2: the dim + colour grade. This is the contrast pass. ───────── */
  .scrim{
    position:fixed; inset:0; z-index:2; pointer-events:none;
    background:
      linear-gradient(180deg, rgba(4,5,12,.86) 0%, rgba(4,5,12,.62) 38%, rgba(4,5,12,.90) 100%),
      radial-gradient(1100px 620px at 12% -6%, rgba(255,106,0,.20), transparent 62%),
      radial-gradient(900px 520px at 90% 8%,  rgba(0,229,255,.18), transparent 60%);
  }
  /* Cool the midtones so the neon reads hotter against them. */
  .grade{
    position:fixed; inset:0; z-index:2; pointer-events:none;
    background:#0a1030; mix-blend-mode:color; opacity:.34;
  }

  /* ── Layer 3: vignette ─────────────────────────────────────────────────── */
  .vignette{
    position:fixed; inset:0; z-index:3; pointer-events:none;
    background:radial-gradient(120% 85% at 50% 42%, transparent 34%, rgba(2,3,8,.82) 100%);
  }

  /* ── Layer 4: Scrapyard furniture, on top of the footage ───────────────── */
  .floor{
    position:fixed; left:-50%; right:-50%; top:58%; bottom:-22%; z-index:4;
    background-image:
      linear-gradient(to right, rgba(0,229,255,${hasVideo ? '.10' : '.09'}) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(0,229,255,${hasVideo ? '.10' : '.09'}) 1px, transparent 1px);
    background-size:56px 56px;
    transform:perspective(420px) rotateX(66deg); transform-origin:top center;
    -webkit-mask-image:linear-gradient(to bottom,#000 0%,transparent 78%);
    mask-image:linear-gradient(to bottom,#000 0%,transparent 78%);
    animation:drift 14s linear infinite; opacity:${hasVideo ? '.5' : '.62'};
    pointer-events:none;
  }
  .horizon{
    position:fixed; left:0; right:0; top:58%; height:1px; z-index:4; pointer-events:none;
    background:linear-gradient(90deg,transparent,var(--plasma),var(--blaze),transparent);
    filter:blur(1px); opacity:.55;
  }
  @keyframes drift{from{background-position:0 0}to{background-position:0 112px}}

  /* ── Layer 5: content ──────────────────────────────────────────────────── */
  .wrap{position:relative; z-index:5; width:100%; max-width:33rem; text-align:center}

  .ship{
    display:flex; justify-content:center; margin-bottom:1.5rem;
    animation:hover 3s ease-in-out infinite;
    /* Grounds the ship against the footage instead of floating cut-out. */
    filter:drop-shadow(0 26px 34px rgba(0,0,0,.75));
  }
  @keyframes hover{0%,100%{transform:translateY(-4px)}50%{transform:translateY(4px)}}

  h1{
    font-family:'Orbitron',sans-serif; font-weight:900; text-transform:uppercase;
    font-size:clamp(2.4rem,1.2rem+5vw,4.4rem); line-height:1; letter-spacing:.02em;
    background:linear-gradient(180deg,#fff 8%,var(--blaze-bright) 52%,var(--blaze) 92%);
    -webkit-background-clip:text; background-clip:text; color:transparent;
    filter:drop-shadow(0 0 22px rgba(255,106,0,.5)) drop-shadow(0 4px 18px rgba(0,0,0,.9));
  }
  .tagline{
    font-family:'Orbitron',sans-serif; font-size:.6rem; font-weight:700;
    text-transform:uppercase; letter-spacing:.28em; color:var(--text-dim); margin-top:.9rem;
    text-shadow:0 2px 12px rgba(0,0,0,.9);
  }

  /* The panel is the top of the stack: glass over footage. The rim highlight
     on the top edge plus the deep shadow underneath are what make the layering
     read as deliberate rather than as a flat overlay. */
  .panel{
    position:relative; margin-top:2.2rem; padding:1.9rem; text-align:left;
    background:
      linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.012) 46%),
      linear-gradient(180deg,rgba(13,17,34,.90),rgba(8,11,24,.94));
    -webkit-backdrop-filter:blur(18px) saturate(1.25);
    backdrop-filter:blur(18px) saturate(1.25);
    border:1px solid rgba(120,140,200,.24);
    box-shadow:
      inset 0 1px 0 0 rgba(255,255,255,.16),
      inset 0 -1px 0 0 rgba(0,0,0,.5),
      0 34px 80px -28px rgba(0,0,0,.96),
      0 0 60px -26px var(--plasma);
    clip-path:polygon(14px 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%,0 14px);
  }
  .panel::before{
    content:''; position:absolute; inset:0 0 auto 0; height:2px; opacity:.9;
    background:linear-gradient(90deg,transparent,var(--plasma),transparent);
  }
  @media (min-width:640px){ .panel{padding:2.3rem} }

  .label{
    font-family:'Orbitron',sans-serif; font-size:.58rem; font-weight:700;
    text-transform:uppercase; letter-spacing:.28em; color:var(--text-dim);
  }
  .lede{margin-top:.6rem; font-size:.94rem; line-height:1.65; color:var(--text-dim)}

  .btn{
    display:flex; align-items:center; justify-content:center; gap:.6rem;
    width:100%; margin-top:1.5rem; padding:1rem 1.25rem;
    font-family:'Orbitron',sans-serif; font-size:.74rem; font-weight:700;
    text-transform:uppercase; letter-spacing:.18em; color:#fff; text-decoration:none;
    background:linear-gradient(135deg,var(--blaze),var(--magenta) 130%);
    background-size:220% 100%;
    box-shadow:
      inset 0 1px 0 0 rgba(255,255,255,.3),
      0 0 0 1px rgba(255,255,255,.16),
      0 16px 40px -12px var(--blaze);
    clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);
    transition:filter .2s ease, transform .2s ease, box-shadow .2s ease;
    animation:sweep 3.4s ease-in-out infinite;
  }
  @keyframes sweep{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
  .btn:hover{filter:brightness(1.14) saturate(1.1); transform:translateY(-1px);
    box-shadow:inset 0 1px 0 0 rgba(255,255,255,.36), 0 0 0 1px rgba(255,255,255,.26), 0 20px 52px -10px var(--blaze)}
  .btn:active{transform:translateY(1px) scale(.985)}
  .btn:focus-visible{outline:2px solid var(--plasma); outline-offset:3px}

  .note, .error{
    display:flex; gap:.55rem; align-items:flex-start; margin-top:1.3rem; padding:.8rem;
    font-size:.73rem; line-height:1.6;
  }
  .note{
    border:1px solid rgba(120,140,200,.2); background:rgba(255,255,255,.035);
    color:var(--text-faint);
    box-shadow:inset 0 1px 0 0 rgba(255,255,255,.06);
  }
  .error{
    border:1px solid rgba(255,95,87,.45); background:rgba(255,95,87,.14);
    color:var(--danger); box-shadow:inset 0 1px 0 0 rgba(255,255,255,.08);
  }
  .note svg, .error svg{flex:0 0 auto; margin-top:1px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--toxic)}

  .foot{
    margin-top:1.8rem; font-size:.66rem; color:var(--text-faint); line-height:1.6;
    text-shadow:0 2px 10px rgba(0,0,0,.85);
  }

  /* Motion off: hold the poster still, no drift, no hover, no autoplay. */
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation:none !important; transition:none !important}
    .bg-media{display:none}
  }
</style>
</head>
<body>
${renderBackdrop(background)}
<div class="scrim" aria-hidden="true"></div>
<div class="grade" aria-hidden="true"></div>
<div class="vignette" aria-hidden="true"></div>
<div class="floor" aria-hidden="true"></div>
<div class="horizon" aria-hidden="true"></div>

<main class="wrap">
  <div class="ship" aria-hidden="true">${arthurSvg({ size: 190, accent: '#FF6A00', uid: 'hero' })}</div>

  <h1>Scrapyard</h1>
  <p class="tagline">No health &middot; No levelling &middot; No brakes</p>

  <section class="panel">
    <p class="label">Access</p>
    <p class="lede">
      The crew leaderboard. Sign in with your work Google account to see
      standings, streaks and everyone&rsquo;s achievements.
    </p>

    ${
      error
        ? `<p class="error" role="alert">
             <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M12 3 2 21h20L12 3z"/></svg>
             <span>${esc(error)}</span>
           </p>`
        : ''
    }

    <a class="btn" href="${esc(loginUrl)}" rel="nofollow">
      ${GOOGLE_MARK}
      Continue with Google
    </a>

    ${
      allowedDomains.length > 0
        ? `<p class="note">
             <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#b6ff3c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
             <span>Restricted to ${domainList}. Anything else is rejected server-side.</span>
           </p>`
        : ''
    }
  </section>

  <p class="foot">
    Themed after BlazeRush by Targem Games. Arthur is an original drawing.
  </p>
</main>
${hasVideo ? BACKDROP_SCRIPT : ''}
</body>
</html>`;
}

/**
 * Reveals the media layer only once it's genuinely playing, so a blocked embed
 * or a failed decode leaves the poster and grid visible instead of a black
 * rectangle. Also skipped entirely under prefers-reduced-motion.
 */
const BACKDROP_SCRIPT = `<script>
(function(){
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var video = document.querySelector('video.bg-media');
  if (video) {
    var reveal = function(){ video.classList.add('ready'); };
    if (video.readyState >= 3) reveal();
    video.addEventListener('canplay', reveal, { once: true });
    // Some browsers refuse autoplay until a play() call is made explicitly.
    var attempt = video.play();
    if (attempt && attempt.catch) attempt.catch(function(){});
    return;
  }

  var embed = document.getElementById('bgEmbed');
  if (!embed) return;
  // The iframe gives us no reliable playing signal without the JS API, so give
  // it a beat to start rendering, then fade it in over the poster.
  embed.addEventListener('load', function(){
    setTimeout(function(){ embed.classList.add('ready'); }, 900);
  });
})();
</script>`;
