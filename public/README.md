# This directory is empty on purpose

Vercel requires a static output directory, and `vercel.json` points at this one.
It stays empty because **nothing in this app may be served without a session
check.**

Anything placed here is served directly by the CDN, from the filesystem, before
routing ever reaches the rewrite in `vercel.json` — which means before the
session gate in `apps/api/src/web/serve-spa.ts` gets a say. That gate is the
reason `/login` is a separate server-rendered page rather than a route inside
the SPA: an anonymous visitor receives neither `index.html` nor the JavaScript
bundle, and the client-side route guard is a convenience rather than the
boundary. A file dropped in here quietly opts out of all of that.

So: the built bundle lives in `apps/web/dist` and reaches the deployment through
`functions.includeFiles` in `vercel.json`, where the function reads and gates it.

## The one change worth considering later

A handful of paths are already public by design — `isOpenPath` in `serve-spa.ts`
lets `/manifest.webmanifest`, `/sw.js`, `/icons/*` and `/favicon.ico` through
without a session, because the browser fetches them without carrying our cookie
and the PWA install prompt depends on them.

Those could be copied here after the build and served by the CDN instead, which
would cost fewer function invocations and less origin transfer. It is a real
optimisation, not done yet because it adds a build step, and because the amount
it saves on a leaderboard for one team is small. If you do it, copy only those
paths — never `index.html` and never `assets/`.
