import { useEffect, useMemo, useRef, useState } from 'react'
import { assignLanding, creatorUrl, trackLanding } from './landingExperiment'
import { trackFunnelConversion } from './adsConversions'
import { buildOccasionSuggestions } from './occasions'

const apiBase = (import.meta.env.VITE_API_BASE_URL || 'https://api.card-genie.com').replace(/\/$/, '')
const handoffStorageKey = 'cardGenieWelcomeHandoff'
type QuickField = 'from' | 'to' | 'occasion'
import './Welcome.css'

const samples = [
  { id: 'dad', title: 'For the king of the grill', occasion: 'Birthday', style: 'Comic book',
    image: '/birthday-cards/img/dad-50th-comic.webp', alt: 'A personalized comic book birthday card featuring Dad at his grill and coaching baseball',
    prompt: 'Dad is turning 50. He’s our weekend grill master, a Little League coach, and tells the same jokes every year.',
    message: 'Happy 50th! You’re still the weekend grill master and the ultimate coach. Those dad jokes never get old—just like you! Keep hitting home runs in life!', closing: 'Cheers to more grilling and laughter!' },
  { id: 'grandma', title: 'For the heart of the family', occasion: 'Birthday', style: 'Watercolor',
    image: '/birthday-cards/img/grandma-80th-watercolor.webp', alt: 'A watercolor birthday card featuring Grandma having tea in her rose garden',
    prompt: 'Grandma Rose is turning 80. She’s tended her rose garden for 50 years, and we love having tea together on her porch.',
    message: 'Cheers to the heart and soul that nurtures both roses and family. Your tea on the porch brings sunshine to our afternoons. Happy 80th birthday, Grandma Rose!', closing: 'With all my love on your special day.' },
  { id: 'anniversary', title: 'For your favorite person', occasion: 'Anniversary', style: 'Watercolor',
    image: '/anniversary-cards/img/wife-10th-watercolor.webp', alt: 'A personalized watercolor anniversary card for a wife',
    prompt: 'Our 10th anniversary. We met in a little bookstore in Portland, and we still read side by side every Sunday.',
    message: 'Every Sunday morning has been a blessing, reading side by side since we met in that charming bookstore. Cheers to a decade of love, laughter, and countless stories together.', closing: 'Forever grateful for you.' },
] as const
type Sample = typeof samples[number]

export default function Welcome() {
  const forced = new URLSearchParams(location.search).get('welcome')
  const preview = forced === 'a' || forced === 'b' || forced === 'c'
  const [assignment] = useState(() => preview ? null : assignLanding())
  const variant = preview ? forced : assignment?.variant || 'b'
  const [opened, setOpened] = useState<Sample | null>(null)
  const [inside, setInside] = useState(false)
  const [sound, setSound] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const audio = useRef<AudioContext | null>(null)
  const viewed = useRef(false)
  const previousFocus = useRef<HTMLElement | null>(null)
  const [quick, setQuick] = useState({ from: '', to: '', occasion: '' })
  const [quickError, setQuickError] = useState('')
  const [popularOccasions, setPopularOccasions] = useState<{ label: string; uses: number }[]>([])
  const [showOccasionList, setShowOccasionList] = useState(false)
  const [activeOccasion, setActiveOccasion] = useState(-1)
  const quickStarted = useRef(false)
  const quickRefs = { from: useRef<HTMLInputElement>(null), to: useRef<HTMLInputElement>(null), occasion: useRef<HTMLInputElement>(null) }
  const occasionSuggestions = useMemo(() => buildOccasionSuggestions(quick.occasion, popularOccasions), [quick.occasion, popularOccasions])

  useEffect(() => {
    if (variant !== 'c') return
    fetch(`${apiBase}/api/occasions`).then(response => response.ok ? response.json() : null)
      .then(data => { if (Array.isArray(data?.occasions)) setPopularOccasions(data.occasions) }).catch(() => {})
  }, [variant])
  useEffect(() => setActiveOccasion(-1), [quick.occasion])

  useEffect(() => {
    if (!viewed.current && assignment) {
      viewed.current = true
      trackLanding('view', assignment)
    }
  }, [assignment])
  useEffect(() => () => { void audio.current?.close() }, [])

  const chime = () => {
    if (!sound) return
    try {
      audio.current ||= new AudioContext()
      void audio.current.resume()
      ;[523.25, 659.25, 783.99].forEach((frequency, index) => {
        const oscillator = audio.current!.createOscillator()
        const gain = audio.current!.createGain()
        const start = audio.current!.currentTime + index * 0.12
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(0.08, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.6)
        oscillator.connect(gain).connect(audio.current!.destination)
        oscillator.start(start)
        oscillator.stop(start + 0.65)
      })
    } catch { /* The visual sample always works without audio. */ }
  }
  const openSample = (sample: Sample) => {
    previousFocus.current = document.activeElement as HTMLElement
    setOpened(sample)
    setInside(false)
    dialog.current?.showModal()
    if (assignment) trackLanding('sample_open', assignment)
    chime()
  }
  const closeSample = () => {
    dialog.current?.close()
    previousFocus.current?.focus()
  }
  const updateQuick = (field: QuickField, value: string) => {
    setQuick(current => ({ ...current, [field]: value }))
    setQuickError('')
    if (!quickStarted.current && assignment) {
      quickStarted.current = true
      trackLanding('form_start', assignment)
    }
  }
  const focusQuick = () => {
    const empty = (['from', 'to', 'occasion'] as QuickField[]).find(field => !quick[field].trim()) || 'from'
    quickRefs[empty].current?.focus()
    return empty
  }
  const goToQuickForm = (occasion?: string) => {
    if (occasion && !quick.occasion.trim()) setQuick(current => ({ ...current, occasion }))
    document.getElementById('welcome-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.setTimeout(focusQuick, 350)
  }
  const pickOccasion = (label: string) => {
    updateQuick('occasion', label)
    setShowOccasionList(false)
  }
  const submitQuick = (event: React.FormEvent) => {
    event.preventDefault()
    const from = quick.from.trim(), to = quick.to.trim(), occasion = quick.occasion.trim()
    if (!from || !to || !occasion) {
      setQuickError('Please fill in all three so Genie can get started.')
      focusQuick()
      return
    }
    // Names stay in this browser; they never go into the URL or analytics.
    try { localStorage.setItem(handoffStorageKey, JSON.stringify({ senderName: from, recipientName: to, occasion, at: Date.now() })) } catch { /* The creator still opens. */ }
    start()
  }
  const begin = (occasion?: string) => variant === 'c' ? goToQuickForm(occasion) : start(occasion)
  const start = (occasion?: string) => {
    if (assignment) {
      trackLanding('create_start', assignment)
      trackFunnelConversion('landing_click', assignment.visitor)
      try { localStorage.setItem('cardGenieWelcomeStarted', '1') } catch { /* URL also bypasses landing. */ }
    }
    location.assign(creatorUrl(occasion, preview))
  }

  return <div className={`welcome welcome-${variant}`}>
    <a className="welcome-skip" href="#welcome-main">Skip to content</a>
    <header className="welcome-header">
      <a className="welcome-brand" href="/" aria-label="Card Genie home"><img src="/logo-mark.png" width="56" height="56" alt="" /><span>Card Genie</span></a>
      <nav aria-label="Welcome navigation"><a href="#examples">See examples</a><button onClick={() => location.assign(creatorUrl(undefined, preview) + '&account=1')}>Sign in</button></nav>
    </header>
    <main id="welcome-main">
      <section className="welcome-hero" aria-labelledby="welcome-heading">
        <div className="welcome-intro">
          <p className="welcome-eyebrow"><span aria-hidden="true">✧</span> THEIR PEOPLE. THEIR PASSIONS. THEIR CARD.</p>
          <h1 id="welcome-heading">{variant === 'a' ? <>Make a card that<br />could only be<br /><em>for them.</em></> : variant === 'c' ? <>Who’s the card <em>for?</em></> : <>Turn your photos and memories into a <em>one-of-a-kind greeting.</em></>}</h1>
          <p className="welcome-lede">{variant === 'a'
            ? 'Turn their favorite things, your shared memories, and optional photos into custom artwork and words that feel like you.'
            : variant === 'c'
              ? 'Start with three quick answers. You can add photos and more details on the next screen.'
              : 'Add a photo and a few details. Genie paints the people you love into custom artwork, with a message written just for them.'}</p>
          {variant === 'c' ? <form className="welcome-quick" onSubmit={submitQuick} noValidate>
            <label>From<input ref={quickRefs.from} value={quick.from} onChange={event => updateQuick('from', event.target.value)} placeholder="Example: your name" autoComplete="given-name" maxLength={60} /></label>
            <label>To<input ref={quickRefs.to} value={quick.to} onChange={event => updateQuick('to', event.target.value)} placeholder="Example: Jamie" autoComplete="off" maxLength={60} /></label>
            <label className="welcome-quick-occasion">Occasion<input ref={quickRefs.occasion} value={quick.occasion}
              onChange={event => { updateQuick('occasion', event.target.value); setShowOccasionList(true) }}
              onFocus={() => setShowOccasionList(true)}
              onBlur={event => { const input = event.currentTarget; window.setTimeout(() => { if (document.activeElement !== input) setShowOccasionList(false) }, 150) }}
              onKeyDown={event => {
                const open = showOccasionList && occasionSuggestions.length > 0
                if (event.key === 'Escape') setShowOccasionList(false)
                else if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                  event.preventDefault()
                  const step = event.key === 'ArrowDown' ? 1 : -1
                  setActiveOccasion(current => current < 0 && step < 0 ? occasionSuggestions.length - 1 : (current + step + occasionSuggestions.length) % occasionSuggestions.length)
                } else if (event.key === 'Enter' && open && occasionSuggestions[activeOccasion]) {
                  event.preventDefault()
                  pickOccasion(occasionSuggestions[activeOccasion])
                }
              }}
              placeholder="Start typing: birthday, thank you…" autoComplete="off" maxLength={60} role="combobox" aria-autocomplete="list"
              aria-controls="welcome-occasion-suggestions" aria-expanded={showOccasionList && occasionSuggestions.length > 0}
              aria-activedescendant={occasionSuggestions[activeOccasion] ? `welcome-occasion-${activeOccasion}` : undefined} />
              {showOccasionList && occasionSuggestions.length > 0 && <ul id="welcome-occasion-suggestions" role="listbox" aria-label="Occasions">
                {occasionSuggestions.map((label, index) => <li key={label} id={`welcome-occasion-${index}`} role="option" aria-selected={index === activeOccasion}>
                  <button type="button" tabIndex={-1} className={index === activeOccasion ? 'is-active' : undefined} onMouseDown={event => event.preventDefault()} onClick={() => pickOccasion(label)}>{label}</button>
                </li>)}
              </ul>}
            </label>
            {quickError && <p className="welcome-quick-error" role="alert">{quickError}</p>}
            <button className="welcome-primary" type="submit">Start my card <span aria-hidden="true">↗</span></button>
          </form>
          : <div className="welcome-hero-actions"><button className="welcome-primary" onClick={() => start()}>Create My Card <span aria-hidden="true">↗</span></button><a className="welcome-text-link" href="#examples">Take a peek first <span aria-hidden="true">↓</span></a></div>}
          <p className="welcome-reassurance">Free to create & preview. No sign-up to get started.</p>
          <a className="welcome-powered" href="https://www.greetingcarduniverse.com" target="_blank" rel="noreferrer">From the people behind GreetingCardUniverse.com</a>
        </div>
        {variant !== 'b' ? <div className="welcome-card-fan" aria-label="Sample greeting cards">
          {samples.map((sample, index) => <button key={sample.id} className={`welcome-fan-card fan-${index}`} onClick={() => openSample(sample)} aria-label={`Open sample: ${sample.title}`}><img src={sample.image} alt={sample.alt} width="528" height="736" fetchPriority={index === 0 ? 'high' : 'auto'} /><span>Open sample <span aria-hidden="true">↗</span></span></button>)}
          <p className="welcome-hand-note">Their story, beautifully told. <span aria-hidden="true">↖</span></p>
        </div> : <figure className="welcome-transformation welcome-photo-pair" aria-label="A real photo and the card Card Genie made from it">
          <div className="welcome-photo-original"><img src="/welcome/photo-to-card-photo.webp" width="480" height="640" alt="The original party photo of two friends, Robin and Lesley, smiling together" fetchPriority="high" /><span>THE PHOTO</span></div>
          <span className="welcome-magic-arrow" aria-hidden="true">✧ →</span>
          <div className="welcome-result"><img src="/welcome/photo-to-card-card.webp" width="528" height="736" alt="The watercolor congratulations card Card Genie made from that photo: Robin and Lesley holding a trophy, with a Price is Right winner banner" fetchPriority="high" /><span>…AND GENIE CREATES THIS</span></div>
          <figcaption>A real Card Genie card, shared with permission.</figcaption>
        </figure>}
      </section>

      <div className="welcome-promise"><span>Made around <strong>your person</strong></span><span>Artwork + a <strong>personal message</strong></span><span>Send by <strong>email or text</strong></span><span>Or <strong>print & mail</strong></span></div>

      <section className="welcome-examples" id="examples" aria-labelledby="examples-heading">
        <div className="welcome-section-heading"><div><p className="welcome-eyebrow">A LITTLE INSPIRATION</p><h2 id="examples-heading">Not just a card.<br />An <em>“oh, that’s so me.”</em></h2></div><p>See how a few personal details become something worth opening. Tap a card to see the cover and message.</p></div>
        <div className="welcome-gallery">{samples.map(sample => <article key={sample.id}>
          <button className="welcome-gallery-art" onClick={() => openSample(sample)} aria-label={`Preview ${sample.title}`}><img src={sample.image} alt={sample.alt} width="528" height="736" loading="lazy" /><span className="welcome-open-label">Open sample ↗</span></button>
          <div className="welcome-sample-caption"><span>{sample.occasion} · {sample.style}</span><h3>{sample.title}</h3><button className="welcome-text-link" onClick={() => begin(sample.occasion)}>Make one for someone I love ↗</button></div>
        </article>)}</div>
        <p className="welcome-example-note">Illustrative examples made with Card Genie. Sample people and stories are fictional.</p>
      </section>

      <section className="welcome-how" aria-labelledby="how-heading"><p className="welcome-eyebrow">YOU BRING THE THOUGHT. GENIE BRINGS THE MAGIC.</p><h2 id="how-heading">From “what should I say?”<br />to <em>“I made this for you.”</em></h2><ol><li><span>01</span><h3>Tell us about them</h3><p>A hobby, an inside joke, a memory. Add a photo if you’d like them in the artwork.</p></li><li><span>02</span><h3>Make it yours</h3><p>Genie creates the artwork and message. Preview your card and edit the words for free.</p></li><li><span>03</span><h3>Make their day</h3><p>Send by email or text, or have a printed card mailed. Most cards are ready in a few minutes.</p></li></ol></section>

      <section className="welcome-bottom" aria-labelledby="bottom-heading"><p className="welcome-eyebrow">SOMEONE COME TO MIND?</p><h2 id="bottom-heading">Make them feel<br /><em>one of a kind.</em></h2><button className="welcome-primary" onClick={() => begin()}>Create My Card <span aria-hidden="true">↗</span></button><p>Creating and previewing a card is free, and so is your first send. For current prices on sending and printed cards, see our FAQ.</p><a href="/faq/">See pricing & frequently asked questions ↗</a></section>
    </main>
    <footer className="welcome-footer"><a className="welcome-brand" href="/" aria-label="Card Genie home"><img src="/logo-mark.png" width="38" height="38" alt="" /><span>Card Genie</span></a><p>A little thought. A little magic. A lot of you.</p><nav aria-label="Footer"><a href="/faq/">FAQ</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a></nav></footer>

    <dialog ref={dialog} className="welcome-dialog" aria-labelledby="sample-heading" onCancel={() => previousFocus.current?.focus()} onClick={event => { if (event.target === dialog.current) closeSample() }}>
      <button className="welcome-close" onClick={closeSample} aria-label="Close sample">×</button>
      {opened && <><div className={`welcome-preview-card ${inside ? 'is-inside' : ''}`}><img src={opened.image} width="528" height="736" alt={opened.alt} /><div className="welcome-inside"><span aria-hidden="true">✧</span><p>{opened.message}</p><p><em>{opened.closing}</em></p></div></div><div className="welcome-preview-info"><p className="welcome-eyebrow">A CARD GENIE EXAMPLE</p><h2 id="sample-heading">{opened.title}</h2><p>{opened.prompt}</p><button className="welcome-preview-toggle" onClick={() => { setInside(!inside); chime() }}>{inside ? 'See the cover' : 'Read the message'} <span aria-hidden="true">↗</span></button><label className="welcome-sound"><input type="checkbox" checked={sound} onChange={event => setSound(event.target.checked)} /> Play a little chime when opening</label><button className="welcome-primary" onClick={() => { if (variant === 'c') closeSample(); begin(opened.occasion) }}>Create My Card ↗</button><small>Example preview. Your card will be made just for you.</small></div></>}
    </dialog>
  </div>
}
