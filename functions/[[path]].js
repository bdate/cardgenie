// Cloudflare Pages Function. public/_routes.json limits it to /gcu/* and /GCU/*; everything else
// is served as static files. Other spellings (e.g. /Gcu/) still work via the script in index.html.
const API_ORIGIN = 'https://api.card-genie.com'

export const onRequestGet = async ({ request, next }) => {
  const match = new URL(request.url).pathname.match(/^\/gcu\/0*(\d{1,10})\/?$/i)
  if (!match) {
    return next()
  }
  const page = await fetch(`${API_ORIGIN}/gcu/${match[1]}`)
  if (!page.ok) {
    return next()
  }
  return new Response(page.body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  })
}
