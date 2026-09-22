/**
 * Lamp Genie Realtime (WebRTC) — one microphone grant per session.
 * getUserMedia is called at most once; the MediaStream is held until disconnect.
 *
 * Anti-loop guards:
 * - Mute local mic while Genie is speaking (stops echo self-talk)
 * - English-only transcription + reject CJK/Cyrillic/junk transcripts
 * - After interview complete, keep mic muted and end the session
 */

export type LampGenieCardDetailsPatch = {
  recipientName?: string
  recipientType?: string
  senderName?: string
  occasion?: string
  tone?: string
  imageStyle?: string
  keyDetails?: string
}

export type LampGenieSessionTurn = {
  role: 'user' | 'assistant' | 'system' | 'junk'
  text: string
  at: string
}

export type LampGenieRealtimeHandlers = {
  onNotice?: (message: string) => void
  onListening?: (listening: boolean) => void
  onSpeaking?: (speaking: boolean) => void
  onUserTranscript?: (text: string, isFinal: boolean) => void
  onAssistantTranscript?: (text: string, isFinal: boolean) => void
  onDetails?: (details: LampGenieCardDetailsPatch) => void
  onComplete?: (details: LampGenieCardDetailsPatch) => void
  onError?: (message: string) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onSessionTurn?: (turn: LampGenieSessionTurn) => void
}

export type LampGenieRealtimeSession = {
  disconnect: () => void
  isConnected: () => boolean
  getSessionId: () => string
  getTurns: () => LampGenieSessionTurn[]
}

type SessionTokenResponse = {
  ok?: boolean
  value?: string
  client_secret?: { value?: string }
  error?: string
  model?: string
}

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

/** Silence / echo hallucinations often show up as CJK, Cyrillic, or Whisper filler. */
export const isJunkRealtimeTranscript = (text: string) => {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length < 2) {
    return true
  }
  // Non-Latin scripts (Chinese/Japanese/Korean/Cyrillic/Arabic/etc.) from silence models.
  if (/[\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(trimmed)) {
    return true
  }
  const lower = trimmed.toLowerCase()
  if (
    /^(thanks for watching[.!]?|thank you[.!]?|thanks[.!]?|please subscribe[.!]?|bye[.!]?|you|the end[.!]?|music|applause|字幕|感谢观看)$/i.test(
      lower,
    )
  ) {
    return true
  }
  // Mostly punctuation / symbols.
  const letters = trimmed.replace(/[^a-zA-Z0-9]/g, '')
  if (letters.length < 2) {
    return true
  }
  return false
}

const waitForIceGathering = (pc: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', check)
    window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }, 2500)
  })

const newSessionId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `lamp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Start a Lamp Genie Realtime voice session.
 * Mic permission is requested here once; never again until disconnect().
 */
export const connectLampGenieRealtime = async (options: {
  apiUrl: (path: string) => string
  voice?: string
  shopperFirstName?: string
  handlers?: LampGenieRealtimeHandlers
}): Promise<LampGenieRealtimeSession> => {
  const handlers = options.handlers || {}
  const sessionId = newSessionId()
  const turns: LampGenieSessionTurn[] = []
  let pc: RTCPeerConnection | null = null
  let localStream: MediaStream | null = null
  let dataChannel: RTCDataChannel | null = null
  let remoteAudio: HTMLAudioElement | null = null
  let connected = false
  let assistantBuffer = ''
  let userBuffer = ''
  let genieSpeaking = false
  let interviewComplete = false
  let unmuteTimer = 0
  let endSessionTimer = 0
  let logFlushTimer = 0
  let cleanedUp = false
  const processedToolCalls = new Set<string>()

  const recordTurn = (role: LampGenieSessionTurn['role'], text: string) => {
    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (!cleaned) {
      return
    }
    const turn: LampGenieSessionTurn = {
      role,
      text: cleaned.slice(0, 2000),
      at: new Date().toISOString(),
    }
    turns.push(turn)
    handlers.onSessionTurn?.(turn)
  }

  const flushSessionLog = async (ended = false) => {
    if (turns.length === 0 && !ended) {
      return
    }
    try {
      await fetch(options.apiUrl('/api/realtime/session-log'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          ended,
          shopperFirstName: options.shopperFirstName || undefined,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
          turns,
        }),
        keepalive: ended,
      })
    } catch {
      // Best-effort logging for testing — never block the shopper.
    }
  }

  const setMicEnabled = (enabled: boolean) => {
    if (!localStream) {
      return
    }
    for (const track of localStream.getAudioTracks()) {
      track.enabled = enabled
    }
  }

  const muteForGenieSpeech = () => {
    genieSpeaking = true
    if (unmuteTimer) {
      window.clearTimeout(unmuteTimer)
      unmuteTimer = 0
    }
    setMicEnabled(false)
    handlers.onSpeaking?.(true)
    handlers.onListening?.(false)
  }

  const scheduleUnmuteAfterGenie = () => {
    genieSpeaking = false
    handlers.onSpeaking?.(false)
    if (interviewComplete) {
      setMicEnabled(false)
      return
    }
    if (unmuteTimer) {
      window.clearTimeout(unmuteTimer)
    }
    // Brief settle so Genie's last audio / room echo isn't treated as shopper speech.
    unmuteTimer = window.setTimeout(() => {
      unmuteTimer = 0
      if (!interviewComplete && !cleanedUp) {
        setMicEnabled(true)
      }
    }, 550)
  }

  const rejectPhantomUserAudio = () => {
    sendEvent({ type: 'response.cancel' })
    sendEvent({ type: 'input_audio_buffer.clear' })
  }

  const cleanup = () => {
    if (cleanedUp) {
      return
    }
    cleanedUp = true
    connected = false
    if (unmuteTimer) {
      window.clearTimeout(unmuteTimer)
      unmuteTimer = 0
    }
    if (endSessionTimer) {
      window.clearTimeout(endSessionTimer)
      endSessionTimer = 0
    }
    if (logFlushTimer) {
      window.clearInterval(logFlushTimer)
      logFlushTimer = 0
    }
    void flushSessionLog(true)
    try {
      dataChannel?.close()
    } catch {
      // Ignore.
    }
    dataChannel = null
    try {
      pc?.getSenders().forEach((sender) => {
        try {
          sender.track?.stop()
        } catch {
          // Ignore.
        }
      })
      pc?.close()
    } catch {
      // Ignore.
    }
    pc = null
    if (localStream) {
      for (const track of localStream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore.
        }
      }
    }
    localStream = null
    if (remoteAudio) {
      try {
        remoteAudio.pause()
        remoteAudio.srcObject = null
      } catch {
        // Ignore.
      }
    }
    remoteAudio = null
    handlers.onListening?.(false)
    handlers.onSpeaking?.(false)
    handlers.onDisconnected?.()
  }

  const sendEvent = (event: Record<string, unknown>) => {
    if (!dataChannel || dataChannel.readyState !== 'open') {
      return
    }
    dataChannel.send(JSON.stringify(event))
  }

  const handleToolCall = (name: string, callId: string, argsJson: string) => {
    const toolKey = callId || `${name}:${argsJson}`
    if (processedToolCalls.has(toolKey)) {
      return
    }
    processedToolCalls.add(toolKey)

    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(argsJson || '{}') as Record<string, unknown>
    } catch {
      args = {}
    }

    const asString = (value: unknown) => String(value || '').trim()
    const details: LampGenieCardDetailsPatch = {
      recipientName: asString(args.recipientName) || undefined,
      recipientType: asString(args.recipientType) || undefined,
      senderName: asString(args.senderName) || undefined,
      occasion: asString(args.occasion) || undefined,
      tone: asString(args.tone) || undefined,
      imageStyle: asString(args.imageStyle) || undefined,
      keyDetails: asString(args.keyDetails) || undefined,
    }

    if (name === 'update_card_details') {
      handlers.onDetails?.(details)
      recordTurn('system', `tool:update_card_details ${JSON.stringify(details)}`)
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ ok: true, saved: details }),
        },
      })
      sendEvent({ type: 'response.create' })
      return
    }

    if (name === 'complete_card_interview') {
      interviewComplete = true
      setMicEnabled(false)
      handlers.onDetails?.(details)
      handlers.onComplete?.(details)
      recordTurn('system', `tool:complete_card_interview ${JSON.stringify(details)}`)
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ ok: true, complete: true }),
        },
      })
      // One short closing line, then end the voice session so it can't keep chatting alone.
      sendEvent({
        type: 'response.create',
        response: {
          instructions:
            'Say one short closing sentence: the form is filled — review it below and create the card. Then stop.',
        },
      })
      if (endSessionTimer) {
        window.clearTimeout(endSessionTimer)
      }
      endSessionTimer = window.setTimeout(() => {
        endSessionTimer = 0
        cleanup()
      }, 8000)
      return
    }

    sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }),
      },
    })
    sendEvent({ type: 'response.create' })
  }

  const handleServerEvent = (raw: string) => {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(event.type || '')

    if (type === 'input_audio_buffer.speech_started') {
      // Ignore VAD while Genie is talking or after the interview is done.
      if (genieSpeaking || interviewComplete || !localStream?.getAudioTracks().some((t) => t.enabled)) {
        rejectPhantomUserAudio()
        return
      }
      handlers.onListening?.(true)
      userBuffer = ''
      return
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      handlers.onListening?.(false)
      return
    }
    if (type === 'output_audio_buffer.started' || type === 'response.output_audio.delta') {
      muteForGenieSpeech()
      return
    }
    if (type === 'output_audio_buffer.stopped') {
      scheduleUnmuteAfterGenie()
      return
    }
    if (type === 'response.done') {
      scheduleUnmuteAfterGenie()
      // Prefer output_audio_transcript.done for chat text; here only handle tools.
      assistantBuffer = ''
      const response = event.response as
        | { output?: Array<{ type?: string; name?: string; call_id?: string; arguments?: string }> }
        | undefined
      for (const item of response?.output || []) {
        if (item?.type === 'function_call' && item.name && item.call_id) {
          handleToolCall(item.name, item.call_id, String(item.arguments || '{}'))
        }
      }
      return
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      if (genieSpeaking || interviewComplete) {
        return
      }
      const delta = String(event.delta || '')
      if (delta) {
        userBuffer += delta
        if (!isJunkRealtimeTranscript(userBuffer)) {
          handlers.onUserTranscript?.(userBuffer, false)
        }
      }
      return
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(event.transcript || userBuffer || '').trim()
      userBuffer = ''
      if (!transcript) {
        return
      }
      if (genieSpeaking || interviewComplete || isJunkRealtimeTranscript(transcript)) {
        recordTurn('junk', transcript)
        rejectPhantomUserAudio()
        handlers.onNotice?.('Still listening… say that again a bit clearer.')
        return
      }
      recordTurn('user', transcript)
      handlers.onUserTranscript?.(transcript, true)
      return
    }
    if (type === 'response.output_audio_transcript.delta') {
      const delta = String(event.delta || '')
      if (delta) {
        assistantBuffer += delta
        handlers.onAssistantTranscript?.(assistantBuffer, false)
      }
      return
    }
    if (type === 'response.output_audio_transcript.done') {
      const transcript = String(event.transcript || assistantBuffer || '').trim()
      assistantBuffer = ''
      if (transcript) {
        recordTurn('assistant', transcript)
        handlers.onAssistantTranscript?.(transcript, true)
      }
      return
    }
    if (type === 'response.function_call_arguments.done') {
      handleToolCall(String(event.name || ''), String(event.call_id || ''), String(event.arguments || '{}'))
      return
    }
    if (type === 'error') {
      const error = event.error as { message?: string } | undefined
      const message = error?.message || 'Realtime session error.'
      // Cancels while clearing phantom audio are expected — don't alarm the shopper.
      if (/cancel/i.test(message)) {
        return
      }
      recordTurn('system', `error: ${message}`)
      handlers.onError?.(message)
    }
  }

  handlers.onNotice?.('Connecting secure voice…')
  recordTurn('system', 'session_start')

  // ONE mic grant for this session — held until disconnect().
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch {
    handlers.onError?.('Microphone permission is needed to talk to Genie.')
    throw new Error('Microphone permission denied.')
  }

  const tokenResponse = await fetch(options.apiUrl('/api/realtime/session'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      voice: options.voice || undefined,
      shopperFirstName: options.shopperFirstName || undefined,
      sessionId,
    }),
  })
  const tokenData = (await tokenResponse.json().catch(() => ({}))) as SessionTokenResponse
  const ephemeralKey = String(tokenData.value || tokenData.client_secret?.value || '').trim()
  if (!tokenResponse.ok || !ephemeralKey) {
    cleanup()
    handlers.onError?.(tokenData.error || 'Unable to start a secure voice session.')
    throw new Error(tokenData.error || 'Unable to start realtime session.')
  }

  pc = new RTCPeerConnection()
  remoteAudio = new Audio()
  remoteAudio.autoplay = true
  ;(remoteAudio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true

  pc.ontrack = (event) => {
    if (!remoteAudio) {
      return
    }
    remoteAudio.srcObject = event.streams[0]
    void remoteAudio.play().catch(() => {
      // Autoplay may need the existing user gesture; track still attached.
    })
  }

  for (const track of localStream.getAudioTracks()) {
    pc.addTrack(track, localStream)
  }

  dataChannel = pc.createDataChannel('oai-events')
  dataChannel.addEventListener('open', () => {
    connected = true
    handlers.onConnected?.()
    handlers.onNotice?.('Listening… talk naturally — Genie will reply by voice.')
    // Mute briefly while Genie greets so the greeting can't re-enter the mic.
    muteForGenieSpeech()
    sendEvent({
      type: 'response.create',
      response: {
        instructions:
          'Greet the shopper warmly in one short English sentence, then ask them to tell you about the card they want — who it’s for, who it’s from, the occasion, and any details or memories. Do not ask about tone or art style.',
      },
    })
    logFlushTimer = window.setInterval(() => {
      void flushSessionLog(false)
    }, 12000)
  })
  dataChannel.addEventListener('message', (event) => {
    handleServerEvent(String(event.data || ''))
  })
  dataChannel.addEventListener('close', () => {
    if (connected) {
      cleanup()
    }
  })

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitForIceGathering(pc)

  const sdpResponse = await fetch(REALTIME_CALLS_URL, {
    method: 'POST',
    body: pc.localDescription?.sdp || offer.sdp || '',
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      'Content-Type': 'application/sdp',
    },
  })
  if (!sdpResponse.ok) {
    const errorText = await sdpResponse.text().catch(() => '')
    cleanup()
    handlers.onError?.('Unable to connect Genie voice. Please try again.')
    throw new Error(errorText || `Realtime SDP failed (${sdpResponse.status})`)
  }
  const answerSdp = await sdpResponse.text()
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

  return {
    disconnect: cleanup,
    isConnected: () => connected && Boolean(pc) && !cleanedUp,
    getSessionId: () => sessionId,
    getTurns: () => [...turns],
  }
}
