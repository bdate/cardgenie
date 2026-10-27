// Card Genie's Google Ads tag (AW-18531832400). Included once in every Card Genie page head.
// Page addresses sent to Google are trimmed: card links (/c/<id>) and query values such as
// thank-you names (?from=, ?to=) or card ids (?card=, ?resume=) never leave the site.
// Greeting Card Universe pages (/gcu/...) keep their own tracking and do not load this tag.
;(function () {
  var adsId = 'AW-18531832400'
  if (window.__cardGenieAdsTag) return
  window.__cardGenieAdsTag = true
  if (/^\/gcu\//i.test(location.pathname)) return

  var keptParams = /^(gclid|gbraid|wbraid|dclid|gad_source|gad_campaignid|utm_(source|medium|campaign|term|content|id)|occasion|style)$/i

  var trimUrl = function (url) {
    try {
      var parsed = new URL(url, location.origin)
      if (parsed.origin !== location.origin) return parsed.origin + '/'
      var path = parsed.pathname.replace(/^\/c\/[^/]+/i, '/c/')
      var query = new URLSearchParams()
      parsed.searchParams.forEach(function (value, key) {
        if (keptParams.test(key)) query.append(key, value)
      })
      var search = query.toString()
      return parsed.origin + path + (search ? '?' + search : '')
    } catch (error) {
      return location.origin + '/'
    }
  }

  var script = document.createElement('script')
  script.async = true
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + adsId
  document.head.appendChild(script)

  window.dataLayer = window.dataLayer || []
  window.gtag =
    window.gtag ||
    function () {
      window.dataLayer.push(arguments)
    }
  window.gtag('js', new Date())

  var config = { page_location: trimUrl(location.href) }
  if (document.referrer) config.page_referrer = trimUrl(document.referrer)
  window.gtag('config', adsId, config)
})()
