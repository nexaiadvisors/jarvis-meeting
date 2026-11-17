/**
 * Four-Option Live Animated Portrait Avatar Stage for Recall Output Media.
 *
 * Implements Split-Clock Rendering:
 *   - Visuals render at 30 FPS on the portrait stage (either muted WebRTC <video>
 *     when an external WebRTC stream is active, or the real-time 2D viseme/kinematic
 *     portrait renderer tailored per provider).
 *   - Audio is NEVER played from a WebRTC remote track (which would introduce a
 *     second clock and cause choppy audio in Recall's headless Chromium capture);
 *     audio continues through the page-clocked WavStreamPlayer AudioWorklet, while
 *     its PCM16 stream drives the avatar's real-time lip-sync visemes and head motion.
 */

import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AvatarProviderId } from '../../src/avatar/providers.js'

export interface SpeechMetrics {
  /** Normalized RMS amplitude [0..1] */
  rms: number
  /** Normalized zero-crossing / high-frequency sibilance [0..1] for mouth width vs jaw drop */
  zcr: number
  /** Timestamp (epoch ms) when the last speech chunk was fed */
  updatedAt: number
}

/** Compute real-time RMS + zero-crossing rate from a PCM16 speech chunk for viseme shaping. */
export function computePcm16SpeechMetrics(pcm: Int16Array, now: number = Date.now()): SpeechMetrics {
  if (pcm.length === 0) return { rms: 0, zcr: 0, updatedAt: now }
  let sumSq = 0
  let zeroCrossings = 0
  let prev = pcm[0] ?? 0
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i] ?? 0
    const norm = sample / 32768
    sumSq += norm * norm
    if ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0)) {
      zeroCrossings += 1
    }
    prev = sample
  }
  const rawRms = Math.sqrt(sumSq / pcm.length)
  // Boost speech envelope into [0..1] range for expressive jaw/lip movement
  const rms = Math.min(1, rawRms * 4.2)
  const zcr = Math.min(1, (zeroCrossings / pcm.length) * 3.0)
  return { rms, zcr, updatedAt: now }
}

interface ProviderStyle {
  badge: string
  bgTop: string
  bgBottom: string
  haloColor: string
  skinBase: string
  skinShadow: string
  hairColor: string
  suitColor: string
  lapelColor: string
  shirtColor: string
  tieColor: string
  glasses: boolean
  hairStyle: 'parted' | 'textured' | 'sleek' | 'waves'
}

const PROVIDER_STYLES: Record<AvatarProviderId, ProviderStyle> = {
  'google-live-avatar': {
    badge: 'Google Live Avatar (Stock)',
    bgTop: '#0f172a',
    bgBottom: '#1e3a8a',
    haloColor: '#3b82f6',
    skinBase: '#ecc4a6',
    skinShadow: '#d4a383',
    hairColor: '#1e293b',
    suitColor: '#1e293b',
    lapelColor: '#334155',
    shirtColor: '#f8fafc',
    tieColor: '#2563eb',
    glasses: true,
    hairStyle: 'parted',
  },
  simli: {
    badge: 'Simli Trinity-1 Live',
    bgTop: '#13111c',
    bgBottom: '#2e1065',
    haloColor: '#8b5cf6',
    skinBase: '#e2b291',
    skinShadow: '#c6906d',
    hairColor: '#18181b',
    suitColor: '#27272a',
    lapelColor: '#3f3f46',
    shirtColor: '#f4f4f5',
    tieColor: '#7c3aed',
    glasses: false,
    hairStyle: 'textured',
  },
  'heygen-live-avatar': {
    badge: 'HeyGen LiveAvatar (Lite)',
    bgTop: '#081c24',
    bgBottom: '#0f394c',
    haloColor: '#06b6d4',
    skinBase: '#f0c8ab',
    skinShadow: '#d9aa89',
    hairColor: '#27272a',
    suitColor: '#0f172a',
    lapelColor: '#1e293b',
    shirtColor: '#ffffff',
    tieColor: '#0891b2',
    glasses: true,
    hairStyle: 'sleek',
  },
  'alibaba-live-avatar': {
    badge: 'Alibaba Wan2.1 14B Live',
    bgTop: '#1c140d',
    bgBottom: '#431407',
    haloColor: '#f97316',
    skinBase: '#e8bc9b',
    skinShadow: '#cfa07d',
    hairColor: '#171717',
    suitColor: '#1c1917',
    lapelColor: '#292524',
    shirtColor: '#fafaf9',
    tieColor: '#ea580c',
    glasses: false,
    hairStyle: 'waves',
  },
  // Shown until the Anam video is streaming, and again if it fails.
  anam: {
    badge: 'Anam',
    bgTop: '#0b1220',
    bgBottom: '#134e4a',
    haloColor: '#10b981',
    skinBase: '#ecc4a6',
    skinShadow: '#d4a383',
    hairColor: '#1e293b',
    suitColor: '#111827',
    lapelColor: '#1f2937',
    shirtColor: '#f8fafc',
    tieColor: '#059669',
    glasses: false,
    hairStyle: 'parted',
  },
}

export function AvatarStage({
  provider,
  agentState,
  speechMetricsRef,
  streamUrl,
}: {
  provider: AvatarProviderId
  agentState: string
  speechMetricsRef: MutableRefObject<SpeechMetrics>
  streamUrl?: string | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId = 0
    let smoothJaw = 0
    let smoothWidth = 0

    const render = (tMs: number) => {
      const t = tMs / 1000
      const style = PROVIDER_STYLES[provider] ?? PROVIDER_STYLES['google-live-avatar']
      const w = canvas.width
      const h = canvas.height
      const cx = w / 2
      const cy = h / 2

      // Read live speech metrics (decay rapidly if last chunk > 180ms ago)
      const now = Date.now()
      const ageMs = now - speechMetricsRef.current.updatedAt
      const activeSpeech = agentState === 'speaking' && ageMs < 260
      const targetJaw = activeSpeech
        ? Math.max(0.12, speechMetricsRef.current.rms)
        : agentState === 'speaking'
          ? 0.18 + 0.14 * Math.abs(Math.sin(t * 9.5))
          : 0
      const targetWidth = activeSpeech ? speechMetricsRef.current.zcr : 0.2

      smoothJaw = smoothJaw * 0.68 + targetJaw * 0.32
      smoothWidth = smoothWidth * 0.75 + targetWidth * 0.25

      // 1. Studio backdrop gradient
      const bgGrad = ctx.createRadialGradient(cx, cy - 20, 20, cx, cy, w * 0.6)
      bgGrad.addColorStop(0, style.bgBottom)
      bgGrad.addColorStop(1, style.bgTop)
      ctx.fillStyle = bgGrad
      ctx.fillRect(0, 0, w, h)

      // Subtle speaking aura ring
      const pulse = agentState === 'speaking' ? 1 + smoothJaw * 0.12 : 1
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, (w / 2 - 6) * pulse, 0, Math.PI * 2)
      ctx.strokeStyle =
        agentState === 'speaking'
          ? '#22c55e'
          : agentState === 'thinking'
            ? '#eab308'
            : agentState === 'listening'
              ? '#3b82f6'
              : style.haloColor
      ctx.lineWidth = agentState === 'speaking' ? 4 : 2.5
      ctx.stroke()
      ctx.restore()

      // Natural breathing + subtle head sway + speech nod
      const breathY = Math.sin(t * 1.7) * 2.2
      const swayX = Math.sin(t * 0.85) * 2.8 + (agentState === 'thinking' ? 3.5 : 0)
      const nodY = smoothJaw * 3.2
      const headX = cx + swayX
      const headY = cy - 12 + breathY + nodY

      ctx.save()
      // Clip to circular portrait frame
      ctx.beginPath()
      ctx.arc(cx, cy, w / 2 - 8, 0, Math.PI * 2)
      ctx.clip()

      // 2. Shoulders & Suit Jacket
      ctx.fillStyle = style.suitColor
      ctx.beginPath()
      ctx.ellipse(cx + swayX * 0.4, h + 18 + breathY, 92, 68, 0, Math.PI, 0, false)
      ctx.fill()

      // Shirt V-neck & Tie
      ctx.fillStyle = style.shirtColor
      ctx.beginPath()
      ctx.moveTo(cx - 22 + swayX * 0.5, h - 38 + breathY)
      ctx.lineTo(cx + 22 + swayX * 0.5, h - 38 + breathY)
      ctx.lineTo(cx + swayX * 0.5, h + 8 + breathY)
      ctx.closePath()
      ctx.fill()

      ctx.fillStyle = style.tieColor
      ctx.beginPath()
      ctx.moveTo(cx - 6 + swayX * 0.5, h - 32 + breathY)
      ctx.lineTo(cx + 6 + swayX * 0.5, h - 32 + breathY)
      ctx.lineTo(cx + 8 + swayX * 0.5, h + 6 + breathY)
      ctx.lineTo(cx - 8 + swayX * 0.5, h + 6 + breathY)
      ctx.closePath()
      ctx.fill()

      // 3. Neck
      ctx.fillStyle = style.skinShadow
      ctx.fillRect(headX - 18, headY + 34, 36, 32)

      // 4. Ears
      ctx.fillStyle = style.skinShadow
      ctx.beginPath()
      ctx.ellipse(headX - 46, headY + 4, 8, 15, -0.1, 0, Math.PI * 2)
      ctx.ellipse(headX + 46, headY + 4, 8, 15, 0.1, 0, Math.PI * 2)
      ctx.fill()

      // 5. Face contour (jaw extends slightly with smoothJaw)
      const jawExtension = smoothJaw * 5.5
      ctx.fillStyle = style.skinBase
      ctx.beginPath()
      ctx.ellipse(headX, headY + jawExtension * 0.35, 45, 54 + jawExtension * 0.5, 0, 0, Math.PI * 2)
      ctx.fill()

      // 6. Hair (distinct per provider)
      ctx.fillStyle = style.hairColor
      ctx.beginPath()
      ctx.ellipse(headX, headY - 34, 47, 26, 0, Math.PI, 0, false)
      ctx.fill()
      if (style.hairStyle === 'parted') {
        ctx.beginPath()
        ctx.arc(headX - 24, headY - 32, 22, 0, Math.PI * 1.4)
        ctx.fill()
      } else if (style.hairStyle === 'waves') {
        ctx.beginPath()
        ctx.arc(headX + 20, headY - 34, 24, Math.PI * 0.8, Math.PI * 2)
        ctx.fill()
      }

      // 7. Eyebrows (expressive lift when speaking or thinking)
      const browLift = agentState === 'thinking' ? -3.5 : -smoothJaw * 3.0
      ctx.strokeStyle = style.hairColor
      ctx.lineWidth = 3.2
      ctx.lineCap = 'round'
      // Left brow
      ctx.beginPath()
      ctx.moveTo(headX - 28, headY - 12 + browLift)
      ctx.quadraticCurveTo(headX - 18, headY - 16 + browLift, headX - 8, headY - 12 + browLift)
      ctx.stroke()
      // Right brow
      ctx.beginPath()
      ctx.moveTo(headX + 8, headY - 12 + browLift)
      ctx.quadraticCurveTo(headX + 18, headY - 16 + browLift, headX + 28, headY - 12 + browLift)
      ctx.stroke()

      // 8. Eyes & natural periodic blink (blinks every ~3.8s for 140ms)
      const blinkCycle = t % 3.8
      const isBlinking = blinkCycle > 3.66
      const eyeOpenY = isBlinking ? 0.6 : 5.5
      const gazeOffsetX = agentState === 'thinking' ? 2.5 : Math.sin(t * 0.5) * 1.0

      for (const side of [-1, 1] as const) {
        const ex = headX + side * 18
        const ey = headY - 2
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.ellipse(ex, ey, 9, eyeOpenY, 0, 0, Math.PI * 2)
        ctx.fill()

        if (!isBlinking) {
          ctx.fillStyle = '#1e293b'
          ctx.beginPath()
          ctx.arc(ex + gazeOffsetX, ey, 4.2, 0, Math.PI * 2)
          ctx.fill()
          // Catchlight
          ctx.fillStyle = '#ffffff'
          ctx.beginPath()
          ctx.arc(ex + gazeOffsetX - 1.5, ey - 1.5, 1.3, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Optional studio eyeglasses
      if (style.glasses) {
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.78)'
        ctx.lineWidth = 1.8
        ctx.strokeRect(headX - 31, headY - 10, 24, 16)
        ctx.strokeRect(headX + 7, headY - 10, 24, 16)
        ctx.beginPath()
        ctx.moveTo(headX - 7, headY - 2)
        ctx.lineTo(headX + 7, headY - 2)
        ctx.stroke()
      }

      // 9. Nose
      ctx.strokeStyle = style.skinShadow
      ctx.lineWidth = 2.2
      ctx.beginPath()
      ctx.moveTo(headX, headY - 2)
      ctx.lineTo(headX - 2, headY + 14)
      ctx.lineTo(headX + 4, headY + 15)
      ctx.stroke()

      // 10. Viseme-driven Mouth & Lips
      const mouthY = headY + 29 + jawExtension * 0.25
      const mouthHalfW = 12 + smoothWidth * 6 + smoothJaw * 3
      const mouthOpenH = smoothJaw * 11.5

      if (mouthOpenH < 1.2) {
        // Gentle closed smile
        ctx.strokeStyle = '#9f5848'
        ctx.lineWidth = 2.6
        ctx.beginPath()
        ctx.moveTo(headX - mouthHalfW, mouthY)
        ctx.quadraticCurveTo(headX, mouthY + 3.5, headX + mouthHalfW, mouthY)
        ctx.stroke()
      } else {
        // Open speaking viseme with upper teeth & tongue shading
        ctx.fillStyle = '#451a1c'
        ctx.beginPath()
        ctx.ellipse(headX, mouthY + mouthOpenH * 0.2, mouthHalfW, mouthOpenH, 0, 0, Math.PI * 2)
        ctx.fill()

        // Upper teeth row
        ctx.fillStyle = '#f8fafc'
        ctx.beginPath()
        ctx.rect(headX - mouthHalfW * 0.7, mouthY - mouthOpenH * 0.65, mouthHalfW * 1.4, Math.min(3.5, mouthOpenH * 0.45))
        ctx.fill()

        // Lip outline
        ctx.strokeStyle = '#a85548'
        ctx.lineWidth = 2.2
        ctx.beginPath()
        ctx.ellipse(headX, mouthY + mouthOpenH * 0.2, mouthHalfW, mouthOpenH, 0, 0, Math.PI * 2)
        ctx.stroke()
      }

      ctx.restore()
      animId = requestAnimationFrame(render)
    }

    animId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animId)
  }, [provider, agentState, speechMetricsRef])

  const style = PROVIDER_STYLES[provider] ?? PROVIDER_STYLES['google-live-avatar']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          position: 'relative',
          width: 210,
          height: 210,
          borderRadius: '50%',
          overflow: 'hidden',
          boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
        }}
      >
        <canvas
          ref={canvasRef}
          width={210}
          height={210}
          style={{ width: 210, height: 210, display: 'block' }}
        />
        {streamUrl ? (
          <video
            ref={videoRef}
            src={streamUrl}
            autoPlay
            playsInline
            muted
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              borderRadius: '50%',
            }}
          />
        ) : null}
      </div>
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.4,
          padding: '2px 10px',
          borderRadius: 999,
          background: 'rgba(255,255,255,0.07)',
          border: '1px solid rgba(255,255,255,0.15)',
          color: '#94a3b8',
        }}
      >
        Avatar: {style.badge}
      </div>
    </div>
  )
}
