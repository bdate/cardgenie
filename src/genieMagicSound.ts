/**
 * Short synthesized "magic sparkle" (rising shimmer + bell chord) for Lamp Genie's sign-off.
 * The AudioContext must be created during a user gesture (iOS starts it suspended otherwise),
 * so call primeGenieMagicSound() from the tap that opens the lamp.
 */

let magicContext: AudioContext | null = null

const getAudioContextClass = () =>
  typeof window === 'undefined'
    ? null
    : window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || null

export const primeGenieMagicSound = () => {
  const AudioContextClass = getAudioContextClass()
  if (!AudioContextClass) {
    return
  }
  try {
    if (!magicContext || magicContext.state === 'closed') {
      magicContext = new AudioContextClass()
    }
    if (magicContext.state === 'suspended') {
      void magicContext.resume().catch(() => {})
    }
  } catch {
    magicContext = null
  }
}

const playTone = (
  ctx: AudioContext,
  destination: AudioNode,
  { frequency, start, duration, peak, type = 'sine' }: {
    frequency: number
    start: number
    duration: number
    peak: number
    type?: OscillatorType
  },
) => {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(frequency, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(gain)
  gain.connect(destination)
  osc.start(start)
  osc.stop(start + duration + 0.05)
}

export const playGenieMagicSound = () => {
  primeGenieMagicSound()
  const ctx = magicContext
  if (!ctx) {
    return
  }
  try {
    const now = ctx.currentTime + 0.05
    const master = ctx.createGain()
    master.gain.value = 0.32

    // Simple feedback echo for a shimmering tail.
    const delay = ctx.createDelay(1)
    delay.delayTime.value = 0.13
    const feedback = ctx.createGain()
    feedback.gain.value = 0.38
    const wet = ctx.createGain()
    wet.gain.value = 0.45
    master.connect(ctx.destination)
    master.connect(delay)
    delay.connect(feedback)
    feedback.connect(delay)
    delay.connect(wet)
    wet.connect(ctx.destination)

    // Rising sparkle glissando (C major pentatonic, two octaves).
    const sparkle = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349.3, 2637, 3136, 3520]
    sparkle.forEach((frequency, index) => {
      playTone(ctx, master, {
        frequency,
        start: now + index * 0.045,
        duration: 0.32,
        peak: 0.16,
        type: 'triangle',
      })
    })

    // Soft bell chord to land the magic.
    const chordStart = now + sparkle.length * 0.045 + 0.04
    ;[523.25, 659.25, 783.99, 1046.5].forEach((frequency) => {
      playTone(ctx, master, { frequency, start: chordStart, duration: 1.6, peak: 0.12 })
      playTone(ctx, master, { frequency: frequency * 2.01, start: chordStart, duration: 0.9, peak: 0.03 })
    })
  } catch {
    // Sound is decorative — never interrupt the shopper if audio fails.
  }
}
