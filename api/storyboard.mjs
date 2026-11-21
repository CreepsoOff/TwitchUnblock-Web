// Fonction Vercel : storyboard d'une VOD (vignettes de la barre de
// progression et des cartes de VOD).
//
// Le JSON de Twitch (`seekPreviewsURL`, sur CloudFront) n'a pas d'en-tête
// CORS pour une autre origine que twitch.tv : le navigateur ne peut pas le
// lire lui-même. Cette fonction le lit côté serveur et renvoie une version
// réduite, mise en cache par le CDN de Vercel. Elle ne touche ni au quota
// du Worker ni aux relais vidéo. Les planches JPG, elles, sont chargées
// directement par le navigateur (une image n'a pas besoin de CORS).
//
// GET /api/storyboard?id=<id de VOD>
// → { storyboard: { sheets, cols, rows, w, h, interval, count } | null }

const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const ID_RE = /^\d{1,15}$/
// Une VOD terminée ne change plus : un jour. Une VOD encore en cours n'a pas
// de storyboard (CloudFront répond 403) : on redemande dans 5 minutes.
const CACHE_DONE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
const CACHE_NONE = 'public, max-age=60, s-maxage=300'

function reply(body, status, cache) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function seekPreviews(id) {
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query($id: ID!) { video(id: $id) { status seekPreviewsURL } }', variables: { id } }),
  })
  if (!res.ok) throw new Error(`GQL ${res.status}`)
  const video = (await res.json())?.data?.video
  if (!video || video.status === 'RECORDING' || !video.seekPreviewsURL) return null
  const url = new URL(video.seekPreviewsURL)
  // Adresse donnée par Twitch, mais on ne lit que ses storyboards.
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudfront.net') || !url.pathname.endsWith('-info.json')) return null
  return url
}

/** Planche « high » de préférence (vignettes plus nettes), sinon « low ». */
function pick(list, infoUrl) {
  if (!Array.isArray(list)) return null
  const ok = (s) => s && Array.isArray(s.images) && s.images.length && [s.count, s.cols, s.rows, s.width, s.height, s.interval].every((n) => Number(n) > 0)
  const s = list.find((x) => x?.quality === 'high' && ok(x)) ?? list.find(ok)
  if (!s) return null
  return {
    sheets: s.images.map((name) => new URL(String(name), infoUrl).href),
    cols: Number(s.cols),
    rows: Number(s.rows),
    w: Number(s.width),
    h: Number(s.height),
    interval: Number(s.interval),
    count: Number(s.count),
  }
}

export default {
  async fetch(request) {
    const id = new URL(request.url).searchParams.get('id') || ''
    if (!ID_RE.test(id)) return reply({ error: 'bad_id' }, 400, CACHE_NONE)
    try {
      const infoUrl = await seekPreviews(id)
      if (!infoUrl) return reply({ storyboard: null }, 200, CACHE_NONE)
      const res = await fetch(infoUrl)
      if (!res.ok) return reply({ storyboard: null }, 200, CACHE_NONE)
      const storyboard = pick(JSON.parse(await res.text()), infoUrl)
      return reply({ storyboard }, 200, storyboard ? CACHE_DONE : CACHE_NONE)
    } catch {
      return reply({ storyboard: null }, 502, 'no-store')
    }
  },
}
