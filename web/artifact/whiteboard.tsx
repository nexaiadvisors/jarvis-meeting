/**
 * The whiteboard: an Excalidraw canvas. A new whiteboard holds Mermaid text written by
 * the bot; on first open it is converted to editable Excalidraw shapes and saved back as
 * an Excalidraw scene. After that the stored content is the scene itself.
 */

import { useEffect, useRef, useState } from 'react'
import { Excalidraw, convertToExcalidrawElements, getSceneVersion } from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import { parseScene, type StoredScene } from './sync.js'

interface Props {
  /** The artifact content when this canvas was mounted (remounted when another person's version loads). */
  content: string
  /**
   * Called with the scene JSON whenever the drawing changes. `automatic` is true for the
   * one save that stores a new whiteboard's converted shapes, which no person made.
   */
  onChange: (content: string, automatic?: boolean) => void
}

type Initial = { elements: unknown[]; files: Record<string, unknown>; converted: boolean }

export default function Whiteboard({ content, onChange }: Props) {
  const [initial, setInitial] = useState<Initial | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sceneVersionRef = useRef(-1)

  useEffect(() => {
    let stopped = false
    const scene = parseScene(content)
    if (scene) {
      setInitial({ elements: scene.elements, files: scene.files ?? {}, converted: false })
      return
    }
    if (content.trim() === '') {
      setInitial({ elements: [], files: {}, converted: false })
      return
    }
    // Shapes are sized around their labels, so the drawing font must be loaded before the
    // labels are measured; otherwise text overflows its box.
    const fontReady = document.fonts
      .load('20px Excalifont')
      .then(() => document.fonts.ready)
      .catch(() => undefined)
    fontReady
      .then(() => parseMermaidToExcalidraw(content))
      .then(({ elements, files }) => {
        if (stopped) return
        setInitial({
          elements: convertToExcalidrawElements(elements as never) as unknown[],
          files: (files ?? {}) as Record<string, unknown>,
          converted: true,
        })
      })
      .catch(() => {
        if (!stopped) setError('This whiteboard’s diagram text could not be drawn. You can still draw on an empty board.')
      })
    return () => {
      stopped = true
    }
    // Mount-time only: the parent remounts this component for a new remote version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Save the converted shapes once, so the next person opens shapes, not Mermaid text.
  useEffect(() => {
    if (initial?.converted) {
      const scene: StoredScene = { type: 'excalidraw', elements: initial.elements, files: initial.files }
      onChange(JSON.stringify(scene), true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])

  if (!initial && !error) return <p className="af-message">Drawing the whiteboard…</p>

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {error && (
        <div className="af-notice" role="alert">
          {error}
        </div>
      )}
      <Excalidraw
        excalidrawAPI={(api) => {
          // Fit the drawing in view once the canvas has its size.
          setTimeout(() => api.scrollToContent(undefined, { fitToContent: true, animate: false }), 150)
        }}
        initialData={{ elements: (initial?.elements ?? []) as never, files: (initial?.files ?? {}) as never, scrollToContent: true }}
        onChange={(elements, _appState, files) => {
          // Excalidraw calls this on every pointer move; only a changed drawing is a change.
          const version = getSceneVersion(elements)
          if (sceneVersionRef.current === -1) {
            sceneVersionRef.current = version
            return
          }
          if (version === sceneVersionRef.current) return
          sceneVersionRef.current = version
          const scene: StoredScene = {
            type: 'excalidraw',
            elements: elements.filter((el) => !el.isDeleted) as unknown[],
            files: files as unknown as Record<string, unknown>,
          }
          onChange(JSON.stringify(scene))
        }}
      />
    </div>
  )
}
