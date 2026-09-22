/**
 * Lamp Genie Realtime (WebRTC) — one microphone grant per session.
 * getUserMedia is called at most once; the MediaStream is held until disconnect.
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
}

export type LampGenieRealtimeSession = {
  disconnect: () => void
  isConnected: () => boolean
}

type SessionTokenResponse = {
  ok?: boolean
  value?: string
  client_secret?: { value?: string }
  error?: string
  model?: string
}

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

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
  let pc: RTCPeerConnection | null = null
  let localStream: MediaStream | null = null
  let dataChannel: RTCDataChannel | null = null
  let remoteAudio: HTMLAudioElement | null = null
  let connected = false
  let assistantBuffer = ''
  let userBuffer = ''
  const processedToolCalls = new Set<string>()

  const cleanup = () => {
    connected = false
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
      handlers.onDetails?.(details)
      handlers.onComplete?.(details)
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ ok: true, complete: true }),
        },
      })
      sendEvent({ type: 'response.create' })
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
      handlers.onListening?.(true)
      handlers.onSpeaking?.(false)
      userBuffer = ''
      return
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      handlers.onListening?.(false)
      return
    }
    if (type === 'output_audio_buffer.started' || type === 'response.output_audio.delta') {
      handlers.onSpeaking?.(true)
      handlers.onListening?.(false)
      return
    }
    if (type === 'output_audio_buffer.stopped') {
      handlers.onSpeaking?.(false)
      return
    }
    if (type === 'response.done') {
      handlers.onSpeaking?.(false)
      if (assistantBuffer.trim()) {
        handlers.onAssistantTranscript?.(assistantBuffer.trim(), true)
        assistantBuffer = ''
      }
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
      const delta = String(event.delta || '')
      if (delta) {
        userBuffer += delta
        handlers.onUserTranscript?.(userBuffer, false)
      }
      return
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(event.transcript || userBuffer || '').trim()
      userBuffer = ''
      if (transcript) {
        handlers.onUserTranscript?.(transcript, true)
      }
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
      handlers.onError?.(error?.message || 'Realtime session error.')
    }
  }

  handlers.onNotice?.('Connecting secure voice…')

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
    // Kick off Genie's greeting once the data channel is ready.
    sendEvent({
      type: 'response.create',
      response: {
        instructions:
          'Greet the shopper warmly in one short sentence, then ask them to tell you about the card they want — who it’s for, who it’s from, the occasion, and any details or memories.',
      },
    })
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
    isConnected: () => connected && Boolean(pc),
  }
}
