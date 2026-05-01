import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type CardDetails = {
  recipientName: string
  recipientType: string
  senderName: string
  occasion: string
  tone: string
  length: string
  imageStyle: string
  keyDetails: string
}

type GeneratedCard = {
  imageUrl: string
  message: string
  closing?: string
}

type ExperienceStep = 'envelope' | 'envelopeFlip' | 'envelopeBack' | 'opening' | 'front' | 'cardOpening' | 'inside'
type EditorTab = 'front' | 'inside'
type CoverRefinementMode = 'revise' | 'new'

const initialDetails: CardDetails = {
  recipientName: 'Carol',
  recipientType: 'Mom',
  senderName: 'David',
  occasion: '90th Birthday',
  tone: 'Heartfelt',
  length: 'Medium, 60-80 words',
  imageStyle: 'Claymation-inspired 3D scene',
  keyDetails:
    "Carol, my mom, recently moved from Georgia to California and is now living near us in the Bay Area. Carol has light brown hair. This card should celebrate her happy 90th birthday as a major milestone, with the heartfelt message that the greatest gift is having her here with all of us in Danville, California. As her son David, I am deeply grateful and excited that after 35 years, we are back in the same town together. The card should feel warm, celebratory, and family-centered, honoring the joy of Mom spending this season of life surrounded by her family: David, her 60-year-old son with gray hair, no facial hair, and modern black-framed glasses; Tiffanie, her daughter-in-law with long wavy brown hair; Emily, her 30-year-old granddaughter, and Emily's husband Alex, age 34 with brown hair; Naomi, her 3-year-old great-granddaughter; Silas, her 1-year-old great-grandson; and Audrey, her 28-year-old granddaughter with dark brown hair.",
}

const toneOptions = ['Heartfelt', 'Playful', 'Elegant', 'Funny', 'Romantic', 'Encouraging']
const lengthOptions = ['Short, 25-40 words', 'Medium, 60-80 words', 'Long, 100-130 words']
const styleOptions = [
  'AI chooses the best style for this card',
  'Photorealistic warm portrait photography',
  'Premium editorial illustration',
  'Watercolor greeting card illustration',
  'Comic book art',
  'Whimsical storybook illustration',
  'Animated 3D family-film style',
  'Minimal modern flat vector art',
  'Elegant botanical paper-cut style',
  'Cozy hand-drawn colored pencil',
  'Retro travel poster style',
  'Claymation-inspired 3D scene',
  'Luxury foil and paper collage',
  'Soft pastel nursery-book illustration',
  'Bold graphic poster art',
  'Vintage greeting card illustration',
]

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const apiUrl = (path: string) => `${apiBaseUrl}${path}`
const hostedApiMessage =
  'This online demo needs a deployed API server before Card Genie can generate cards. Run it locally with the Express server, or connect VITE_API_BASE_URL to a hosted backend.'

const getApiJson = async (response: Response, fallbackMessage: string) => {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return response.json()
  }

  if (!response.ok) {
    throw new Error(window.location.hostname.endsWith('github.io') && !apiBaseUrl ? hostedApiMessage : fallbackMessage)
  }

  throw new Error(fallbackMessage)
}

const splitMessageParts = (message: string, senderName: string) => {
  const senderPattern = senderName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let cleanMessage = message
    .replace(/\[your name\]/gi, '')
    .replace(/^\s*dear\s+[^,\n]+,?\s*/i, '')
    .trim()

  if (senderPattern) {
    cleanMessage = cleanMessage.replace(new RegExp(`\\s*,?\\s*${senderPattern}\\s*$`, 'i'), '').trim()
  }

  const closingMatch = cleanMessage.match(
    /\s*(with all my love|with love|love|sincerely|warmly|best|cheers|thinking of you),?\s*$/i,
  )

  if (!closingMatch) {
    return {
      body: cleanMessage,
      closing: 'With love,',
    }
  }

  return {
    body: cleanMessage.slice(0, closingMatch.index).trim(),
    closing: `${closingMatch[1]},`,
  }
}

const splitIntoParagraphs = (message: string) => {
  const explicitParagraphs = message
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  if (explicitParagraphs.length > 1) {
    return explicitParagraphs
  }

  const sentences = message
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  if (sentences.length <= 2) {
    return [message.trim()].filter(Boolean)
  }

  const paragraphs: string[] = []
  for (let index = 0; index < sentences.length; index += 2) {
    paragraphs.push(sentences.slice(index, index + 2).join(' '))
  }

  return paragraphs
}

function App() {
  const [details, setDetails] = useState<CardDetails>(initialDetails)
  const [card, setCard] = useState<GeneratedCard | null>(null)
  const [step, setStep] = useState<ExperienceStep>('envelope')
  const [isGenerating, setIsGenerating] = useState(false)
  const [showCompletionNote, setShowCompletionNote] = useState(false)
  const [activeGenerationStep, setActiveGenerationStep] = useState(0)
  const [imageRefinement, setImageRefinement] = useState('')
  const [coverRefinementMode, setCoverRefinementMode] = useState<CoverRefinementMode>('revise')
  const [copyRefinement, setCopyRefinement] = useState('')
  const [isRefiningImage, setIsRefiningImage] = useState(false)
  const [isRefiningCopy, setIsRefiningCopy] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [editorTab, setEditorTab] = useState<EditorTab>('front')
  const [showPolishDialog, setShowPolishDialog] = useState(false)
  const [cardGreeting, setCardGreeting] = useState('')
  const [error, setError] = useState('')

  const recipientLabel = useMemo(
    () => details.recipientName.trim() || details.recipientType.trim() || 'Someone special',
    [details.recipientName, details.recipientType],
  )
  const envelopeLabel = useMemo(
    () => details.recipientType.trim() || details.recipientName.trim() || 'Someone special',
    [details.recipientName, details.recipientType],
  )
  const senderLabel = useMemo(() => details.senderName.trim() || 'Your Name', [details.senderName])
  const stampSrc = `${import.meta.env.BASE_URL}stamp.webp`
  const insideGreeting = cardGreeting.trim() || `Dear ${envelopeLabel},`
  const rawMessage = card?.message ?? ''
  const messageParts = useMemo(() => {
    const parts = splitMessageParts(rawMessage, senderLabel)
    return {
      body: parts.body,
      closing: card?.closing?.trim() || parts.closing,
    }
  }, [card?.closing, rawMessage, senderLabel])
  const cardMessage = messageParts.body
  const messageParagraphs = useMemo(() => splitIntoParagraphs(cardMessage), [cardMessage])
  const messageDensity = cardMessage.length > 620 ? 'is-long' : cardMessage.length > 420 ? 'is-medium' : 'is-short'
  const generationLines = useMemo(
    () => [
      `Coming up with a creative ${details.occasion || 'card'} image for ${envelopeLabel}.`,
      `Writing a ${details.tone.toLowerCase()} note that sounds personal, not canned.`,
      `Blending the ${details.imageStyle.toLowerCase()} look with the story you shared.`,
      'Getting the envelope, cover, and inside message ready for a first look.',
    ],
    [details.imageStyle, details.occasion, details.tone, envelopeLabel],
  )

  useEffect(() => {
    if (!isGenerating) {
      return
    }

    const timer = window.setInterval(() => {
      setActiveGenerationStep((current) => (current + 1) % generationLines.length)
    }, 2200)

    return () => window.clearInterval(timer)
  }, [generationLines.length, isGenerating])

  const updateDetails = (field: keyof CardDetails, value: string) => {
    setDetails((current) => ({
      ...current,
      [field]: value,
    }))
  }

  const generateCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setIsGenerating(true)
    setShowCompletionNote(false)
    setActiveGenerationStep(0)
    setShowEditor(false)
    setShowPolishDialog(false)
    setStep('envelope')

    try {
      const response = await fetch(apiUrl('/api/generate-card'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(details),
      })

      const data = await getApiJson(response, 'Unable to generate the card.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to generate the card.')
      }

      setCard({
        imageUrl: data.imageUrl,
        message: data.message,
        closing: data.closing,
      })
      setCardGreeting(`Dear ${envelopeLabel},`)
      setStep('envelope')
      setShowCompletionNote(true)
      window.setTimeout(() => setShowCompletionNote(false), 6000)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to generate the card.')
    } finally {
      setIsGenerating(false)
    }
  }

  const openInside = () => {
    setStep('cardOpening')
    window.setTimeout(() => {
      setStep('inside')
    }, 1800)
  }

  const openEnvelope = () => {
    setStep('opening')
    window.setTimeout(() => setStep('front'), 6200)
  }

  const playEnvelopeBack = () => {
    setStep('envelopeBack')
    window.setTimeout(openEnvelope, 350)
  }

  const flipEnvelope = () => {
    setStep('envelopeFlip')
    window.setTimeout(playEnvelopeBack, 2400)
  }

  const replayAnimation = () => {
    setShowEditor(false)
    setShowPolishDialog(false)
    setStep('envelope')
  }

  const openEditor = () => {
    setShowEditor(true)
    setEditorTab(step === 'inside' ? 'inside' : 'front')
  }

  const updateCardMessage = (message: string) => {
    setCard((current) => (current ? { ...current, message } : current))
  }

  const updateCardClosing = (closing: string) => {
    setCard((current) => (current ? { ...current, closing } : current))
  }

  const refineImage = async () => {
    if (!card) {
      return
    }

    setError('')
    setIsRefiningImage(true)

    try {
      const response = await fetch(apiUrl('/api/refine-image'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          details,
          refinement: imageRefinement,
          imageMode: coverRefinementMode,
        }),
      })

      const data = await getApiJson(response, 'Unable to refine the cover image.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to refine the cover image.')
      }

      setCard((current) => (current ? { ...current, imageUrl: data.imageUrl } : current))
      setImageRefinement('')
      setStep('front')
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to refine the cover image.')
    } finally {
      setIsRefiningImage(false)
    }
  }

  const refineCopy = async () => {
    if (!card) {
      return
    }

    setError('')
    setIsRefiningCopy(true)

    try {
      const response = await fetch(apiUrl('/api/refine-copy'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          details,
          refinement: copyRefinement,
          currentMessage: cardMessage,
          currentClosing: messageParts.closing,
        }),
      })

      const data = await getApiJson(response, 'Unable to refine the inside message.')

      if (!response.ok) {
        throw new Error(data.error || 'Unable to refine the inside message.')
      }

      setCard((current) =>
        current
          ? {
              ...current,
              message: data.message,
              closing: data.closing,
            }
          : current,
      )
      setCopyRefinement('')
      setShowPolishDialog(false)
      setStep('inside')
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Unable to refine the inside message.')
    } finally {
      setIsRefiningCopy(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-section">
        <div className="eyebrow">Card Genie</div>
        <h1>Any Card Imaginable</h1>
        <p>Powered by Card Genie. Thoughtfulness made easy.</p>
      </section>

      <section className="workspace">
        <form className="card-panel form-panel" onSubmit={generateCard}>
          <div className="panel-heading">
            <span>01</span>
            <div>
              <h2>Tell us about the card</h2>
              <p>One set of details powers both the image and the message.</p>
            </div>
          </div>

          <div className="field-grid">
            <label>
              Recipient name
              <input
                value={details.recipientName}
                onChange={(event) => updateDetails('recipientName', event.target.value)}
                placeholder="David"
              />
            </label>

            <label>
              Recipient type
              <input
                required
                value={details.recipientType}
                onChange={(event) => updateDetails('recipientType', event.target.value)}
                placeholder="Mom, spouse, friend, coworker"
              />
            </label>
          </div>

          <div className="field-grid">
            <label>
              Occasion
              <input
                required
                value={details.occasion}
                onChange={(event) => updateDetails('occasion', event.target.value)}
                placeholder="90th birthday, thank you, anniversary"
              />
            </label>

            <label>
              From
              <input
                required
                value={details.senderName}
                onChange={(event) => updateDetails('senderName', event.target.value)}
                placeholder="Your name"
              />
            </label>
          </div>

          <div className="field-grid">
            <label>
              Tone
              <select value={details.tone} onChange={(event) => updateDetails('tone', event.target.value)}>
                {toneOptions.map((tone) => (
                  <option key={tone}>{tone}</option>
                ))}
              </select>
            </label>

            <label>
              Message length
              <select
                value={details.length}
                onChange={(event) => updateDetails('length', event.target.value)}
              >
                {lengthOptions.map((length) => (
                  <option key={length}>{length}</option>
                ))}
              </select>
            </label>
          </div>

          <label>
            Image style
            <select
              value={details.imageStyle}
              onChange={(event) => updateDetails('imageStyle', event.target.value)}
            >
              {styleOptions.map((style) => (
                <option key={style}>{style}</option>
              ))}
            </select>
          </label>

          <label>
            Personal details
            <textarea
              required
              rows={6}
              value={details.keyDetails}
              onChange={(event) => updateDetails('keyDetails', event.target.value)}
              placeholder="Add memories, interests, relationship details, places, colors, or anything the card should include."
            />
          </label>

          {error && <div className="error-message">{error}</div>}

          <button className="primary-button" disabled={isGenerating}>
            {isGenerating ? 'Generating your card...' : card ? 'Regenerate card' : 'Generate card'}
          </button>
        </form>

        <section className="card-panel preview-panel">
          <div className="panel-heading proof-heading">
            <span>02</span>
            <div>
              <h2>{showEditor ? 'Revise your card' : 'Your card proof'}</h2>
            </div>
            {!isGenerating &&
              card &&
              (showEditor ? (
                <button
                  className="secondary-button revise-top-button"
                  type="button"
                  onClick={() => {
                    setShowEditor(false)
                    setShowPolishDialog(false)
                  }}
                >
                  Close Editor
                </button>
              ) : (
                <button className="primary-button revise-top-button" type="button" onClick={openEditor}>
                  Revise card
                </button>
              ))}
          </div>

          {isGenerating && (
            <div className="creative-loader" role="status" aria-live="polite">
              <span className="loader-kicker">Card Genie is creating</span>
              <h3 key={generationLines[activeGenerationStep]}>{generationLines[activeGenerationStep]}</h3>
            </div>
          )}

          {!isGenerating && !card && (
            <div className="empty-state">
              <div className="sparkle">✦</div>
              <h3>No proof yet</h3>
              <p>Fill in the form, then generate a complete digital greeting card.</p>
            </div>
          )}

          {!isGenerating && card && (
            <>
              {!showEditor && (
                <>
              {showCompletionNote && (
                <div className="completion-note">
                  All right, I think I got it. Let me know what you think of this.
                </div>
              )}

              {step === 'envelope' && (
                <button className="proof-stage envelope-scene" type="button" onClick={flipEnvelope}>
                  <div className="envelope">
                    <div className="envelope-front-face">
                      <img className="envelope-stamp" src={stampSrc} alt="" aria-hidden="true" />
                      <span className="envelope-front-address">To {envelopeLabel}</span>
                    </div>
                  </div>
                  <span className="envelope-prompt">Click to Open</span>
                </button>
              )}

              {step === 'envelopeFlip' && (
                <div className="proof-stage envelope-scene" aria-live="polite">
                  <div className="envelope is-flipping">
                    <div className="envelope-front-face">
                      <img className="envelope-stamp" src={stampSrc} alt="" aria-hidden="true" />
                      <span className="envelope-front-address">To {envelopeLabel}</span>
                    </div>
                    <div className="envelope-back-face">
                      <div className="envelope-back" />
                      <div className="envelope-flap envelope-flap-static" />
                      <div className="envelope-body" />
                    </div>
                  </div>
                  <span className="envelope-prompt envelope-prompt-placeholder" aria-hidden="true">
                    Click to Open
                  </span>
                </div>
              )}

              {step === 'envelopeBack' && (
                <div className="proof-stage envelope-scene" aria-live="polite">
                  <div className="envelope envelope-static">
                    <div className="envelope-back-face is-static">
                      <div className="envelope-back" />
                      <div className="envelope-flap envelope-flap-static" />
                      <div className="envelope-body" />
                    </div>
                  </div>
                  <span className="envelope-prompt envelope-prompt-placeholder" aria-hidden="true">
                    Tap to Open
                  </span>
                </div>
              )}

              {step === 'opening' && (
                <div className="proof-stage envelope-scene opening-scene" aria-live="polite">
                  <div className="envelope is-opening">
                    <div className="envelope-back-face">
                      <small aria-hidden="true"></small>
                    </div>
                    <div className="envelope-back" />
                    <div className="envelope-card-rise">
                      <img src={card.imageUrl} alt={`Front of card for ${recipientLabel}`} />
                    </div>
                    <div className="envelope-flap" />
                    <div className="envelope-body">
                      <small aria-hidden="true"></small>
                    </div>
                  </div>
                </div>
              )}

              {step === 'front' && (
                <button className="proof-stage card-reveal front-reveal" type="button" onClick={openInside}>
                  <div className="card-cover-frame">
                    <img src={card.imageUrl} alt={`Front of card for ${recipientLabel}`} />
                  </div>
                  <span>Click to open</span>
                </button>
              )}

              {step === 'cardOpening' && (
                <div className="proof-stage card-open-scene" aria-live="polite">
                  <div className="card-open-stage">
                    <div className={`open-card-message ${messageDensity}`}>
                      <span>{insideGreeting}</span>
                      <div className="message-paragraphs">
                        {messageParagraphs.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                      <div className="card-closing">{messageParts.closing}</div>
                      <div className="card-signature">{senderLabel}</div>
                    </div>
                    <div className="card-opening-cover">
                      <img src={card.imageUrl} alt={`Opening card cover for ${recipientLabel}`} />
                    </div>
                  </div>
                </div>
              )}

              {step === 'inside' && (
                <div className="proof-stage card-open-scene is-static-inside">
                  <div className="open-card">
                    <div className={`open-card-message ${messageDensity}`}>
                      <span>{insideGreeting}</span>
                      <div className="message-paragraphs">
                        {messageParagraphs.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                      <div className="card-closing">{messageParts.closing}</div>
                      <div className="card-signature">{senderLabel}</div>
                    </div>
                  </div>
                </div>
              )}

              <div className="proof-actions">
                <button className="secondary-button" type="button" onClick={replayAnimation}>
                  Replay animation
                </button>
              </div>
                </>
              )}

              {showEditor && (
                <div className="card-editor">
                  <nav className="card-thumbnails editor-thumbnails" aria-label="Card editor pages">
                    <button
                      className={editorTab === 'front' ? 'is-selected' : ''}
                      type="button"
                      onClick={() => setEditorTab('front')}
                    >
                      <img src={card.imageUrl} alt="" />
                      <span>Cover</span>
                    </button>
                    <button
                      className={editorTab === 'inside' ? 'is-selected' : ''}
                      type="button"
                      onClick={() => setEditorTab('inside')}
                    >
                      <span className="inside-thumb">Aa</span>
                      <span>Inside</span>
                    </button>
                  </nav>

                  <div className={`editor-layout ${editorTab === 'inside' ? 'is-inside-editor' : ''}`}>
                    {editorTab === 'front' && (
                      <div className="editor-preview">
                        <div className="card-cover-frame editor-cover-frame">
                          <img src={card.imageUrl} alt={`Cover preview for ${recipientLabel}`} />
                        </div>
                      </div>
                    )}

                    <div className="refinement-panel">
                      {editorTab === 'front' ? (
                        <div className="refinement-card">
                          <h3>Refine the cover</h3>
                          <p>
                            Describe what should change. By default, Card Genie keeps the same concept and only revises the cover.
                          </p>
                          <div className="mode-toggle" aria-label="Cover refinement mode">
                            <button
                              className={coverRefinementMode === 'revise' ? 'is-selected' : ''}
                              type="button"
                              onClick={() => setCoverRefinementMode('revise')}
                            >
                              Revise current concept
                            </button>
                            <button
                              className={coverRefinementMode === 'new' ? 'is-selected' : ''}
                              type="button"
                              onClick={() => setCoverRefinementMode('new')}
                            >
                              Whole new concept
                            </button>
                          </div>
                          <textarea
                            rows={5}
                            value={imageRefinement}
                            onChange={(event) => setImageRefinement(event.target.value)}
                            placeholder={
                              coverRefinementMode === 'revise'
                                ? 'Example: keep the same scene, but make it more joyful, add flowers, and keep text farther from the edges.'
                                : 'Example: create a completely different cover concept with a sunny garden party and elegant birthday text.'
                            }
                          />
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={isRefiningImage || !imageRefinement.trim()}
                            onClick={refineImage}
                          >
                            {isRefiningImage
                              ? 'Updating cover...'
                              : coverRefinementMode === 'revise'
                                ? 'Revise cover image'
                                : 'Create new concept'}
                          </button>
                        </div>
                      ) : (
                        <div className="refinement-card inside-refinement-card">
                          <div className="inside-editor-header">
                            <h3>Edit Inside</h3>
                            <button className="polish-button" type="button" onClick={() => setShowPolishDialog(true)}>
                              <span className="polish-icon" aria-hidden="true">
                                CG
                              </span>
                              Card Genie
                            </button>
                          </div>
                          <label>
                            Greeting
                            <input value={insideGreeting} onChange={(event) => setCardGreeting(event.target.value)} />
                          </label>
                          <label>
                            Inside message
                            <textarea
                              rows={10}
                              value={cardMessage}
                              onChange={(event) => updateCardMessage(event.target.value)}
                            />
                          </label>
                          <label>
                            Closing
                            <input
                              value={messageParts.closing}
                              onChange={(event) => updateCardClosing(event.target.value)}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {showPolishDialog && (
                <div className="polish-dialog-backdrop">
                  <div className="polish-dialog" role="dialog" aria-modal="true" aria-labelledby="polish-title">
                    <div className="polish-dialog-heading">
                      <span className="polish-icon" aria-hidden="true">
                        CG
                      </span>
                      <div>
                        <h3 id="polish-title">Polish with Card Genie</h3>
                        <p>Tell Card Genie how to revise the message while keeping it personal.</p>
                      </div>
                    </div>
                    <textarea
                      rows={5}
                      value={copyRefinement}
                      onChange={(event) => setCopyRefinement(event.target.value)}
                      placeholder="Example: make it shorter, warmer, funnier, or more specific about the move to Georgia."
                    />
                    <div className="polish-dialog-actions">
                      <button className="secondary-button" type="button" onClick={() => setShowPolishDialog(false)}>
                        Cancel
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={isRefiningCopy || !copyRefinement.trim()}
                        onClick={refineCopy}
                      >
                        {isRefiningCopy ? 'Polishing...' : 'Polish copy'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </section>
    </main>
  )
}

export default App
