import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { addPropertyControls, ControlType, RenderTarget } from "framer"
import {
  motion,
  animate,
  useInView,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  type AnimationPlaybackControls,
} from "framer-motion"

type FillType = "solid" | "gradient" | "animated-gradient" | "cutout"
type TouchBehavior = "drag" | "sweep" | "static"
type TextAlign = "left" | "center" | "right"
type TextFit = "wrap" | "fill-width"

interface FontValue {
  fontFamily?: string
  fontWeight?: number
  fontStyle?: string
}

interface ContentGroup {
  text: string
  font: FontValue
  fontSize: number
  letterSpacing: number
  lineHeight: number
  textAlign: TextAlign
  textFit: TextFit
}

interface StrokeGroup {
  strokeColor: string
  strokeWidth: number
  strokeOpacity: number
}

interface FillGroup {
  fillType: FillType
  fillColor: string
  fillGradientStart: string
  fillGradientEnd: string
  gradientAngle: number
  gradientSpeed: number
  backdropColor: string
}

interface RevealGroup {
  radius: number
  edgeHardness: number
  followDelay: number
}

interface InteractionGroup {
  touchBehavior: TouchBehavior
  idleAnimation: boolean
  padding: string
}

interface TraceRevealProps {
  content: ContentGroup
  stroke: StrokeGroup
  fill: FillGroup
  reveal: RevealGroup
  interaction: InteractionGroup
  style?: CSSProperties
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// Expands a CSS padding shorthand string ("10px" / "10px 20px" / ... / "10px 20px 30px 40px")
// into per-side px numbers, following standard CSS shorthand expansion rules.
const parsePadding = (value: string) => {
  const parts = value
    .trim()
    .split(/\s+/)
    .map((part) => parseFloat(part) || 0)
  const [top = 0, right = top, bottom = top, left = right] = parts
  return { top, right, bottom, left }
}

// Pure rect math, no DOM writes — cheap enough to run on every window pointermove. Used to
// treat the padded zone around the component as part of the hit area without any element
// actually occupying that space (so it can't be clipped by an ancestor's overflow: clip).
type EdgeInsets = { top: number; right: number; bottom: number; left: number }
const isPointInExpandedRect = (
  rect: DOMRect,
  padding: EdgeInsets,
  x: number,
  y: number
) =>
  x >= rect.left - padding.left &&
  x <= rect.right + padding.right &&
  y >= rect.top - padding.top &&
  y <= rect.bottom + padding.bottom

// Canvas 2D has no native letter-spacing, so runs are measured/drawn one character at a
// time, advancing by each glyph's own width plus the spacing. Approximates CSS
// letter-spacing (which technically also adds trailing space after the last character);
// close enough for mask-shape purposes.
const measureRunWidth = (ctx: CanvasRenderingContext2D, run: string, letterSpacing: number) => {
  if (!run) return 0
  let width = 0
  for (const char of run) width += ctx.measureText(char).width + letterSpacing
  return width
}

const fillRunWithSpacing = (
  ctx: CanvasRenderingContext2D,
  run: string,
  x: number,
  y: number,
  letterSpacing: number
) => {
  let cursor = x
  for (const char of run) {
    ctx.fillText(char, cursor, y)
    cursor += ctx.measureText(char).width + letterSpacing
  }
}

// Same per-character advance as fillRunWithSpacing, but strokes instead of fills — used
// with globalCompositeOperation "destination-out" to inset the ink shape (see the ink-
// shape inset comment where this is called).
const strokeRunWithSpacing = (
  ctx: CanvasRenderingContext2D,
  run: string,
  x: number,
  y: number,
  letterSpacing: number
) => {
  let cursor = x
  for (const char of run) {
    ctx.strokeText(char, cursor, y)
    cursor += ctx.measureText(char).width + letterSpacing
  }
}

// Manual word-wrap approximating CSS white-space:pre-wrap + overflow-wrap:break-word —
// respects existing line breaks in the source text, then greedily wraps by word within
// maxWidth. Not guaranteed to match the browser's own line-breaking in every edge case
// (unusual scripts, kerning), but close for the common case of plain wrapped text.
const wrapCanvasText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  letterSpacing: number
) => {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ")
    let currentLine = ""
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word
      if (currentLine && measureRunWidth(ctx, candidate, letterSpacing) > maxWidth) {
        lines.push(currentLine)
        currentLine = word
      } else {
        currentLine = candidate
      }
    }
    lines.push(currentLine)
  }
  return lines
}

const IDLE_DELAY_MS = 3000

/**
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 480
 * @framerIntrinsicHeight 160
 */
export default function TraceReveal(props: TraceRevealProps) {
  const {
    content = {} as ContentGroup,
    stroke = {} as StrokeGroup,
    fill = {} as FillGroup,
    reveal = {} as RevealGroup,
    interaction = {} as InteractionGroup,
  } = props

  const {
    text = "Hover to reveal",
    font,
    fontSize = 64,
    letterSpacing = 0,
    lineHeight = 1.1,
    textAlign = "center",
    textFit = "wrap",
  } = content
  const {
    fontFamily = "Inter, sans-serif",
    fontWeight = 700,
    fontStyle = "normal",
  } = font ?? {}

  const {
    strokeColor = "#000000",
    strokeWidth = 1,
    strokeOpacity = 1,
  } = stroke

  const {
    fillType = "solid",
    fillColor = "#3D5AFE",
    fillGradientStart = "#FF6B6B",
    fillGradientEnd = "#4ECDC4",
    gradientAngle = 45,
    gradientSpeed = 1,
    backdropColor = "#FFFFFF",
  } = fill

  const {
    radius = 80,
    edgeHardness = 0.6,
    followDelay = 0.3,
  } = reveal

  const {
    touchBehavior = "drag",
    idleAnimation = false,
    padding = "80px 40px 80px 40px",
  } = interaction

  // The hit area is expanded beyond the text by this much on each side — computed purely
  // as numbers (see the window-level pointer effect below), not as a DOM element sized via
  // negative insets. That approach broke entirely whenever an ancestor (e.g. a Framer frame
  // with overflow: clip and no spare room) clipped the oversized element before it could
  // ever receive events — a real scenario for a component nested in someone else's layout,
  // not just an edge case. A window-level listener with a manual bounds check has no DOM
  // footprint to clip, so it works regardless of ancestor overflow.
  const hitAreaPadding = useMemo(() => parsePadding(padding), [padding])

  const isCanvas = RenderTarget.current() === RenderTarget.canvas

  const containerRef = useRef<HTMLDivElement>(null)
  const baseTextRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { amount: 0.4, once: false })

  // Cutout mode's backdrop is a directly-drawn <canvas>, not a CSS mask (see the redraw
  // functions further below) — visible canvas, a cached glyph-shape bitmap (redrawn only
  // when the text/font/layout actually changes, not per animation frame), and a reusable
  // per-redraw scratch canvas to avoid allocating a new one every frame.
  const backdropCanvasRef = useRef<HTMLCanvasElement>(null)
  const glyphBitmapCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [fillWidthMetrics, setFillWidthMetrics] = useState({ scale: 1, height: 0 })
  const [isRevealActive, setIsRevealActive] = useState(false)
  const [isTouchDevice, setIsTouchDevice] = useState(false)

  const hasPositionedRef = useRef(false)
  const hasInteractedRef = useRef(false)

  const rawX = useMotionValue(0)
  const rawY = useMotionValue(0)

  // followDelay 0-1 maps to spring stiffness/damping: 0 snaps instantly, 1 lags heavily.
  const springConfig = useMemo(() => {
    const t = clamp01(followDelay)
    return {
      stiffness: lerp(1000, 40, t),
      damping: lerp(35, 20, t),
      mass: 1,
    }
  }, [followDelay])

  const springX = useSpring(rawX, springConfig)
  const springY = useSpring(rawY, springConfig)

  const bgPosition = useMotionValue(0)

  // Cutout mode only: the transparent hole's own radius, grown/shrunk on enter/leave
  // (independent of the position spring above) so it animates in as a spatial reveal
  // rather than a flat fade — the same grow/shrink treatment the circle itself gets.
  const holeRadius = useMotionValue(0)

  // Detect touch/coarse-pointer devices once on mount (guards window for SSR/canvas safety).
  useEffect(() => {
    if (typeof window === "undefined") return
    const query = window.matchMedia("(pointer: coarse)")
    setIsTouchDevice(query.matches)
    const handleChange = () => setIsTouchDevice(query.matches)
    query.addEventListener("change", handleChange)
    return () => query.removeEventListener("change", handleChange)
  }, [])

  // Measure the component's own box for centering, idle drift, and sweep bounds.
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setDimensions({ width, height })
      if (!hasPositionedRef.current && !hasInteractedRef.current) {
        hasPositionedRef.current = true
        rawX.set(width / 2)
        rawY.set(height / 2)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [rawX, rawY])

  // Fill Width mode: measure the live text layer's natural (unscaled) width — scrollWidth
  // is transform-invariant, so it's safe to read directly off the real, visible element
  // regardless of whatever scale is currently applied to it. The wrapper's height is NOT
  // measured at all: since we force lineHeight to "1" ourselves (see sharedTextStyle), the
  // text's unscaled layout-box height is exactly `fontSize` by construction — scaling that
  // by the same factor gives the wrapper's height an exact match to what the transformed
  // text actually occupies, rather than an approximation of it (a previous version of this
  // measured tight ink bounds instead, which undershot the real rendered line-box height
  // and left Framer's own layout under-reserving space for the text). Runs in a layout
  // effect so the corrected scale/height apply before paint, avoiding a flash of the
  // untransformed size. In "wrap" mode this resets to a no-op, untouched.
  useLayoutEffect(() => {
    if (textFit !== "fill-width") {
      setFillWidthMetrics({ scale: 1, height: 0 })
      return
    }
    const el = baseTextRef.current
    if (!el || !dimensions.width) return
    const naturalWidth = el.scrollWidth
    if (!naturalWidth) return
    const scale = dimensions.width / naturalWidth
    setFillWidthMetrics({ scale, height: fontSize * scale })
  }, [textFit, dimensions.width, fontSize, text, letterSpacing, fontFamily, fontWeight, fontStyle])

  const staticTouchFill = touchBehavior === "static" && isTouchDevice

  // Listens on window rather than a padded DOM overlay: the padded zone is expanded purely
  // by number, in isPointInExpandedRect, against the container's own real (unpadded)
  // getBoundingClientRect(). That rect is nothing more than the component's actual box, so
  // there's no oversized element for an ancestor's overflow: clip to cut off. Coordinates
  // are still measured relative to that same real box, since that's the coordinate space
  // the mask and text layers render in.
  useEffect(() => {
    const textEl = containerRef.current
    if (!textEl || staticTouchFill) return

    const processPoint = (clientX: number, clientY: number) => {
      const rect = textEl.getBoundingClientRect()
      if (!isPointInExpandedRect(rect, hitAreaPadding, clientX, clientY)) {
        setIsRevealActive(false)
        return
      }
      hasInteractedRef.current = true
      rawX.set(clientX - rect.left)
      rawY.set(clientY - rect.top)
      setIsRevealActive(true)
    }

    const handlePointerMove = (event: PointerEvent) => processPoint(event.clientX, event.clientY)
    const handlePointerDown = (event: PointerEvent) => processPoint(event.clientX, event.clientY)
    const handlePointerLeave = () => setIsRevealActive(false)
    const handlePointerCancel = () => setIsRevealActive(false)

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("pointerleave", handlePointerLeave)
    window.addEventListener("pointercancel", handlePointerCancel)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("pointerleave", handlePointerLeave)
      window.removeEventListener("pointercancel", handlePointerCancel)
    }
  }, [rawX, rawY, staticTouchFill, hitAreaPadding])

  // Idle drift: only outside the canvas editor, only after a pause in real input.
  useEffect(() => {
    if (!idleAnimation || isCanvas || staticTouchFill) return
    if (!dimensions.width || !dimensions.height) return

    const textEl = containerRef.current
    if (!textEl) return

    let xControls: AnimationPlaybackControls | undefined
    let yControls: AnimationPlaybackControls | undefined
    let idleTimeout: number | undefined

    const stopIdle = () => {
      xControls?.stop()
      yControls?.stop()
    }
    const startIdle = () => {
      const left = dimensions.width * 0.15
      const right = dimensions.width * 0.85
      xControls = animate(rawX, [left, right, left], {
        duration: 6,
        repeat: Infinity,
        ease: "easeInOut",
      })
      yControls = animate(rawY, dimensions.height / 2, { duration: 0.6 })
      setIsRevealActive(true)
    }
    const scheduleIdle = () => {
      window.clearTimeout(idleTimeout)
      idleTimeout = window.setTimeout(startIdle, IDLE_DELAY_MS)
    }
    const handleActivity = (event: PointerEvent) => {
      const rect = textEl.getBoundingClientRect()
      if (!isPointInExpandedRect(rect, hitAreaPadding, event.clientX, event.clientY)) return
      stopIdle()
      scheduleIdle()
    }

    window.addEventListener("pointermove", handleActivity)
    window.addEventListener("pointerdown", handleActivity)
    scheduleIdle()

    return () => {
      window.clearTimeout(idleTimeout)
      stopIdle()
      window.removeEventListener("pointermove", handleActivity)
      window.removeEventListener("pointerdown", handleActivity)
    }
  }, [idleAnimation, isCanvas, staticTouchFill, dimensions, rawX, rawY, hitAreaPadding])

  // Auto-sweep: a one-pass reveal each time the component enters view on touch.
  useEffect(() => {
    if (touchBehavior !== "sweep" || !isTouchDevice || isCanvas) return
    if (!isInView || !dimensions.width || !dimensions.height) return

    rawY.set(dimensions.height / 2)
    setIsRevealActive(true)
    const controls = animate(rawX, [0, dimensions.width], {
      duration: 1.4,
      ease: "easeInOut",
    })
    return () => controls.stop()
  }, [touchBehavior, isTouchDevice, isCanvas, isInView, dimensions, rawX, rawY])

  // Animated-gradient hue/position drift, CSS-only (no WebGL), paused in the canvas editor.
  useEffect(() => {
    if (fillType !== "animated-gradient" || isCanvas) return
    const duration = clamp01(gradientSpeed / 5) > 0 ? 12 / Math.max(gradientSpeed, 0.05) : Infinity
    const controls = animate(bgPosition, 200, {
      duration,
      repeat: Infinity,
      ease: "linear",
    })
    return () => controls.stop()
  }, [fillType, gradientSpeed, isCanvas, bgPosition])

  // Cutout mode: grow the hole in on enter, shrink it back out on leave. A short spring,
  // no overshoot (so it never dips negative). Position still comes from springX/springY —
  // this only drives size.
  useEffect(() => {
    if (fillType !== "cutout") {
      holeRadius.set(0)
      return
    }
    const controls = animate(holeRadius, isRevealActive ? radius : 0, {
      type: "spring",
      duration: 0.25,
      bounce: 0,
    })
    return () => controls.stop()
  }, [fillType, isRevealActive, radius, holeRadius])

  const backgroundPositionTemplate = useMotionTemplate`${bgPosition}% 50%`

  const revealVisible = staticTouchFill || isRevealActive

  // hardness 0 = feathered across the whole radius, 1 = crisp cutoff at the edge. Clamped
  // a hair inside [0, 100] so the two "black" stops (and the black/transparent boundary at
  // hardness 1) are never at the exact same position — some renderers mis-render truly
  // coincident same-color stops instead of treating them as the well-defined no-op CSS
  // intends, which otherwise let hardness 0 reveal unbounded instead of staying within the
  // radius, and left a small residual feather at hardness 1 that should be fully crisp.
  const innerStopPercent = clamp01(edgeHardness) * 100
  const innerStopSafe = Math.min(Math.max(innerStopPercent, 0.1), 99.9)
  const maskImage = useMotionTemplate`radial-gradient(circle ${radius}px at ${springX}px ${springY}px, black 0%, black ${innerStopSafe}%, transparent 100%)`

  const isFillWidth = textFit === "fill-width"
  const isCutout = fillType === "cutout"

  // The backdrop's hole must be the INTERSECTION of the circle and the glyph ink — not the
  // circle alone (leaks into the gaps between letters) and not a static copy of the glyph
  // shape (never reaches the real background). After three attempts to get this right via
  // CSS mask-composite/mask-mode ran into browser-specific SVG-luminance/CSS-alpha mask
  // interop that couldn't be debugged without live inspection, this is computed directly
  // with canvas 2D compositing instead — deterministic, no mask-mode/mask-type involved.
  //
  // redrawGlyphBitmap draws the glyph shapes (solid, any color — only alpha/shape matters)
  // onto a cached, off-DOM canvas. It's async because it gates the first draw on the font
  // actually being loaded: canvas 2D resolves fonts through a separate pipeline from CSS
  // text layout, and drawing before a custom weight/family is ready silently substitutes a
  // fallback font, producing a mask shape that doesn't match the real rendered letters (the
  // same root cause behind an earlier, now-fixed bug in this file). This bitmap is cheap to
  // reuse frame-to-frame since it only depends on text/font/layout, never cursor position.
  const redrawGlyphBitmap = useCallback(async () => {
    if (typeof document === "undefined" || !dimensions.width || !dimensions.height) return
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
    if (!glyphBitmapCanvasRef.current) {
      glyphBitmapCanvasRef.current = document.createElement("canvas")
    }
    const canvas = glyphBitmapCanvasRef.current
    canvas.width = Math.max(1, Math.round(dimensions.width * dpr))
    canvas.height = Math.max(1, Math.round(dimensions.height * dpr))
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const weight = fontWeight ?? 400
    const style = fontStyle ?? "normal"
    const fontSpec = `${style} ${weight} ${fontSize}px ${fontFamily}`

    if (typeof document.fonts?.load === "function") {
      try {
        await document.fonts.load(fontSpec, text || " ")
        await document.fonts.ready
      } catch {
        // Best effort — still draw below even if preloading itself rejects.
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, dimensions.width, dimensions.height)
    ctx.fillStyle = "black"
    ctx.font = fontSpec
    ctx.textBaseline = "alphabetic"

    // Real, measured ascent/descent for this exact font/weight/size — NOT the specific
    // text's ink bounds (that's actualBoundingBoxAscent/Descent, content-dependent and
    // wrong for this purpose), but fontBoundingBoxAscent/Descent, which reflects the
    // font's own design metrics the same way for any string. That's what CSS text layout
    // actually uses to place the baseline within a line box, so it's what has to drive
    // this too. A single measurement is reused for every line below, since these values
    // don't depend on which characters are being measured, only the font/size in ctx.font.
    const metrics = ctx.measureText(text || " ")
    const fontAscent = metrics.fontBoundingBoxAscent ?? fontSize * 0.8
    const fontDescent = metrics.fontBoundingBoxDescent ?? fontSize * 0.2

    // Mirrors the real CSS baseline placement formula: within a line box of height
    // lineHeightPx, the font's own (ascent + descent) sits centered, with the baseline
    // offset from the line's top by that centering gap ("half-leading") plus the ascent.
    const baselineOffset = (lineHeightPx: number) =>
      (lineHeightPx - (fontAscent + fontDescent)) / 2 + fontAscent

    // -webkit-text-stroke paints centered on the glyph outline — half its width bleeds
    // outward (already outside this fill, nothing to adjust there) and half bleeds inward,
    // into what this fill alone would otherwise treat as solid ink. Without correcting for
    // that, the hole computed from this shape starts revealing half a stroke-width before
    // the visible stroke actually ends, producing a visible double edge. Erasing a stroke
    // of the FULL strokeWidth (not half), centered on the same outline via destination-out,
    // only actually removes pixels on the side that overlaps existing fill — the outward
    // half falls where there was never any ink to erase — so the net effect is exactly the
    // strokeWidth/2 inward inset needed, without computing an offset path by hand.
    const insetWidth = Math.max(0, strokeWidth)

    if (isFillWidth) {
      // Fill Width forces lineHeight:1 in the real rendered CSS (see sharedTextStyle), so
      // its line box height is exactly fontSize.
      ctx.save()
      ctx.scale(fillWidthMetrics.scale, fillWidthMetrics.scale)
      const y = baselineOffset(fontSize)
      fillRunWithSpacing(ctx, text, 0, y, letterSpacing)
      if (insetWidth > 0) {
        ctx.globalCompositeOperation = "destination-out"
        ctx.lineWidth = insetWidth
        strokeRunWithSpacing(ctx, text, 0, y, letterSpacing)
        ctx.globalCompositeOperation = "source-over"
      }
      ctx.restore()
    } else {
      const lines = wrapCanvasText(ctx, text, dimensions.width, letterSpacing)
      const lineHeightPx = fontSize * lineHeight
      const firstLineBaseline = baselineOffset(lineHeightPx)
      const linePositions = lines.map((line, i) => {
        const lineWidth = measureRunWidth(ctx, line, letterSpacing)
        const x =
          textAlign === "center"
            ? (dimensions.width - lineWidth) / 2
            : textAlign === "right"
              ? dimensions.width - lineWidth
              : 0
        const y = lineHeightPx * i + firstLineBaseline
        fillRunWithSpacing(ctx, line, x, y, letterSpacing)
        return { line, x, y }
      })
      if (insetWidth > 0) {
        ctx.globalCompositeOperation = "destination-out"
        ctx.lineWidth = insetWidth
        linePositions.forEach(({ line, x, y }) =>
          strokeRunWithSpacing(ctx, line, x, y, letterSpacing)
        )
        ctx.globalCompositeOperation = "source-over"
      }
    }
  }, [
    dimensions.width,
    dimensions.height,
    text,
    fontFamily,
    fontWeight,
    fontStyle,
    fontSize,
    letterSpacing,
    lineHeight,
    textAlign,
    isFillWidth,
    fillWidthMetrics.scale,
    strokeWidth,
  ])

  // Runs every time the circle's position/size changes (see the motion-value subscriptions
  // below) plus whenever the "slow" inputs (color, hardness, dimensions) change. Draws a
  // solid backdropColor rect, then erases exactly ink ∩ circle from it: first compositing
  // the cached glyph bitmap with the circle gradient via "source-in" on a scratch canvas
  // (keeping only ink that falls inside the circle, feathered by Edge Hardness), then
  // erasing that result from the main canvas via "destination-out". Two lightweight
  // composites per frame — the expensive text draw only happens in redrawGlyphBitmap above.
  const redrawBackdrop = useCallback(() => {
    const canvas = backdropCanvasRef.current
    const glyphCanvas = glyphBitmapCanvasRef.current
    if (!canvas || !dimensions.width || !dimensions.height) return
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
    const targetW = Math.max(1, Math.round(dimensions.width * dpr))
    const targetH = Math.max(1, Math.round(dimensions.height * dpr))
    if (canvas.width !== targetW) canvas.width = targetW
    if (canvas.height !== targetH) canvas.height = targetH
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = "source-over"
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = backdropColor
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Static touch fill: fully opaque, no hole, matching the other layers' static behavior.
    if (staticTouchFill || !glyphCanvas) return

    if (!scratchCanvasRef.current) {
      scratchCanvasRef.current = document.createElement("canvas")
    }
    const scratch = scratchCanvasRef.current
    if (scratch.width !== canvas.width) scratch.width = canvas.width
    if (scratch.height !== canvas.height) scratch.height = canvas.height
    const sctx = scratch.getContext("2d")
    if (!sctx) return

    sctx.setTransform(1, 0, 0, 1, 0, 0)
    sctx.globalCompositeOperation = "source-over"
    sctx.clearRect(0, 0, scratch.width, scratch.height)
    sctx.drawImage(glyphCanvas, 0, 0)

    const cx = springX.get() * dpr
    const cy = springY.get() * dpr
    const r = Math.max(0.01, holeRadius.get() * dpr)
    const hardnessStop = clamp01(innerStopSafe / 100)

    sctx.globalCompositeOperation = "source-in"
    const gradient = sctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    gradient.addColorStop(0, "black")
    gradient.addColorStop(Math.min(0.999, hardnessStop), "black")
    gradient.addColorStop(1, "rgba(0,0,0,0)")
    sctx.fillStyle = gradient
    sctx.fillRect(0, 0, scratch.width, scratch.height)

    ctx.globalCompositeOperation = "destination-out"
    ctx.drawImage(scratch, 0, 0)
    ctx.globalCompositeOperation = "source-over"
  }, [
    dimensions.width,
    dimensions.height,
    backdropColor,
    staticTouchFill,
    innerStopSafe,
    springX,
    springY,
    holeRadius,
  ])

  // Glyph bitmap only needs to change when text/font/layout change — not per animation
  // frame — so it's driven by a normal effect, not the motion-value subscriptions below.
  useEffect(() => {
    if (!isCutout) return
    let cancelled = false
    redrawGlyphBitmap().then(() => {
      if (!cancelled) redrawBackdrop()
    })
    return () => {
      cancelled = true
    }
  }, [isCutout, redrawGlyphBitmap, redrawBackdrop])

  // Position/size change on (almost) every frame during interaction — subscribed directly
  // to the motion values (imperative, no React re-render per frame) rather than a separate
  // requestAnimationFrame loop, so the canvas stays in lockstep with the same spring system
  // already driving the glyph-shaped fill layer's circle.
  useEffect(() => {
    if (!isCutout) return
    redrawBackdrop()
    const unsubX = springX.on("change", redrawBackdrop)
    const unsubY = springY.on("change", redrawBackdrop)
    const unsubR = holeRadius.on("change", redrawBackdrop)
    return () => {
      unsubX()
      unsubY()
      unsubR()
    }
  }, [isCutout, springX, springY, holeRadius, redrawBackdrop])

  // In Fill Width mode both layers get the identical transform (same scale, same
  // origin) so they stay pixel-aligned; inline-block makes scrollWidth reflect the
  // text's natural shrink-to-fit size rather than the wrapper's own 100% width.
  const sharedTextStyle: CSSProperties = {
    margin: 0,
    fontFamily,
    fontWeight,
    fontStyle,
    fontSize: `${fontSize}px`,
    letterSpacing: `${letterSpacing}px`,
    // Line-height only matters between lines; Fill Width is always a single line, so a
    // simple tight constant is enough here — the wrapper's actual height comes from a
    // real DOM ink measurement below, not from this value (see the fill-width layout
    // effect and the hidden measurement clone further down).
    lineHeight: isFillWidth ? "1" : `${lineHeight}`,
    textAlign,
    whiteSpace: isFillWidth ? "nowrap" : "pre-wrap",
    overflowWrap: "break-word",
    ...(isFillWidth
      ? {
          display: "inline-block",
          transform: `scale(${fillWidthMetrics.scale})`,
          transformOrigin: "top left",
        }
      : {}),
  }

  const baseTextStyle: CSSProperties = {
    ...sharedTextStyle,
    color: "transparent",
    WebkitTextStroke: `${strokeWidth}px ${strokeColor}`,
    opacity: strokeOpacity,
  }

  // Cutout has no branch here: its glyph-shaped fill layer isn't rendered at all (see
  // below) — the canvas backdrop is now the sole source of the reveal's shape/boundary.
  const fillTextStyle: CSSProperties =
    fillType === "solid"
      ? { ...sharedTextStyle, color: fillColor }
      : {
          ...sharedTextStyle,
          color: "transparent",
          backgroundImage: `linear-gradient(${gradientAngle}deg, ${fillGradientStart}, ${fillGradientEnd})`,
          backgroundClip: "text",
          WebkitBackgroundClip: "text",
          ...(fillType === "animated-gradient" ? { backgroundSize: "200% 200%" } : {}),
        }

  // Explicit height in Fill Width mode: `transform: scale()` never affects layout, so
  // without this the wrapper's auto-height would reflect the natural, unscaled text —
  // too small (or large) once actually rendered, causing it to bleed into neighboring
  // canvas content. Wrap mode is untouched (no height override, same as before).
  const rootStyle: CSSProperties = {
    position: "relative",
    display: "block",
    width: "100%",
    // Only covers the component's own (unpadded) box — a touch starting in the padding-only
    // hit-area zone has no element under it to carry this, so it falls back to default touch
    // scrolling there. That's the trade-off for a padded zone with no DOM footprint of its
    // own to clip.
    touchAction: touchBehavior === "drag" ? "none" : "auto",
    ...(isFillWidth && fillWidthMetrics.height > 0
      ? { height: `${fillWidthMetrics.height}px` }
      : {}),
    ...props.style,
  }

  return (
    <div ref={containerRef} style={rootStyle}>
      {isCutout && (
        /* Cutout only: a canvas painted imperatively by redrawBackdrop (see above) — opaque
           backdropColor everywhere except the ink ∩ circle intersection, computed via canvas
           compositing rather than CSS masking. No interactivity of its own; position/growth/
           hardness come from the same motion values the glyph-shaped fill layer uses.
           Negative z-index keeps this under the (non-positioned, so normally topmost-by-
           default) stroke text below without touching that layer's own styling. */
        <canvas
          ref={backdropCanvasRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: -1,
            pointerEvents: "none",
            width: "100%",
            height: "100%",
          }}
        />
      )}

      {/* Real, selectable, screen-reader-readable text node. */}
      <div ref={baseTextRef} style={baseTextStyle}>{text}</div>

      {/* Decorative fill layer, clipped to the reveal circle. Never part of the a11y tree.
          Not rendered in Cutout mode at all — that mode's entire reveal (shape, boundary,
          and resting appearance) comes from the canvas backdrop below, which is the sole
          authority on where ink meets the circle. Having this layer separately compute
          the same boundary via CSS masking of real DOM text produced a visible double
          edge where its browser-rendered boundary didn't pixel-align with the canvas's
          own text rendering — two independent systems disagreeing at the edge. */}
      {!isCutout && (
        <motion.div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            userSelect: "none",
            opacity: revealVisible ? 1 : 0,
            transition: "opacity 200ms ease",
            WebkitMaskImage: staticTouchFill ? "none" : maskImage,
            maskImage: staticTouchFill ? "none" : maskImage,
            ...(fillType === "animated-gradient"
              ? {
                  backgroundPositionX: backgroundPositionTemplate as unknown as string,
                }
              : {}),
          }}
        >
          <div style={fillTextStyle}>{text}</div>
        </motion.div>
      )}
    </div>
  )
}

addPropertyControls(TraceReveal, {
  content: {
    type: ControlType.Object,
    title: "Content",
    controls: {
      text: {
        type: ControlType.String,
        title: "Text",
        defaultValue: "Hover to reveal",
        displayTextArea: true,
      },
      textFit: {
        type: ControlType.Enum,
        title: "Text Fit",
        defaultValue: "wrap",
        options: ["wrap", "fill-width"],
        optionTitles: ["Wrap (Fixed Size)", "Fill Width (Single Line)"],
      },
      font: {
        type: ControlType.Font,
        title: "Font",
        controls: "basic",
        defaultFontType: "sans-serif",
        defaultValue: { variant: "Bold" },
      },
      fontSize: {
        type: ControlType.Number,
        title: "Font Size",
        defaultValue: 64,
        min: 8,
        max: 300,
        step: 1,
        unit: "px",
        hidden: (props: ContentGroup) => props.textFit === "fill-width",
      },
      letterSpacing: {
        type: ControlType.Number,
        title: "Letter Spacing",
        defaultValue: 0,
        min: -20,
        max: 100,
        step: 0.1,
        unit: "px",
      },
      lineHeight: {
        type: ControlType.Number,
        title: "Line Height",
        defaultValue: 1.1,
        min: 0.5,
        max: 3,
        step: 0.05,
        hidden: (props: ContentGroup) => props.textFit === "fill-width",
      },
      textAlign: {
        type: ControlType.Enum,
        title: "Align",
        defaultValue: "center",
        options: ["left", "center", "right"],
        optionTitles: ["Left", "Center", "Right"],
        displaySegmentedControl: true,
        hidden: (props: ContentGroup) => props.textFit === "fill-width",
      },
    },
  },
  stroke: {
    type: ControlType.Object,
    title: "Stroke",
    controls: {
      strokeColor: {
        type: ControlType.Color,
        title: "Color",
        defaultValue: "#000000",
      },
      strokeWidth: {
        type: ControlType.Number,
        title: "Width",
        defaultValue: 1,
        min: 0,
        max: 10,
        step: 0.1,
        unit: "px",
      },
      strokeOpacity: {
        type: ControlType.Number,
        title: "Opacity",
        defaultValue: 1,
        min: 0,
        max: 1,
        step: 0.01,
      },
    },
  },
  fill: {
    type: ControlType.Object,
    title: "Fill",
    controls: {
      fillType: {
        type: ControlType.Enum,
        title: "Type",
        defaultValue: "solid",
        options: ["solid", "gradient", "animated-gradient", "cutout"],
        optionTitles: ["Solid", "Gradient", "Animated Gradient", "Cutout (Reveal Background)"],
      },
      fillColor: {
        type: ControlType.Color,
        title: "Color",
        defaultValue: "#3D5AFE",
        hidden: (props: FillGroup) => props.fillType !== "solid",
      },
      fillGradientStart: {
        type: ControlType.Color,
        title: "Gradient Start",
        defaultValue: "#FF6B6B",
        hidden: (props: FillGroup) =>
          props.fillType !== "gradient" && props.fillType !== "animated-gradient",
      },
      fillGradientEnd: {
        type: ControlType.Color,
        title: "Gradient End",
        defaultValue: "#4ECDC4",
        hidden: (props: FillGroup) =>
          props.fillType !== "gradient" && props.fillType !== "animated-gradient",
      },
      gradientAngle: {
        type: ControlType.Number,
        title: "Angle",
        defaultValue: 45,
        min: 0,
        max: 360,
        step: 1,
        unit: "deg",
        hidden: (props: FillGroup) =>
          props.fillType !== "gradient" && props.fillType !== "animated-gradient",
      },
      gradientSpeed: {
        type: ControlType.Number,
        title: "Speed",
        defaultValue: 1,
        min: 0,
        max: 5,
        step: 0.1,
        hidden: (props: FillGroup) => props.fillType !== "animated-gradient",
      },
      backdropColor: {
        type: ControlType.Color,
        title: "Backdrop Color",
        defaultValue: "#FFFFFF",
        hidden: (props: FillGroup) => props.fillType !== "cutout",
        description:
          "Place a Framer Shader layer (or any layer) directly behind this component, and set Backdrop Color to match your page background.",
      },
    },
  },
  reveal: {
    type: ControlType.Object,
    title: "Reveal Circle",
    controls: {
      radius: {
        type: ControlType.Number,
        title: "Radius",
        defaultValue: 80,
        min: 10,
        max: 2000,
        step: 1,
        unit: "px",
      },
      edgeHardness: {
        type: ControlType.Number,
        title: "Edge Hardness",
        defaultValue: 0.6,
        min: 0,
        max: 1,
        step: 0.01,
      },
      followDelay: {
        type: ControlType.Number,
        title: "Follow Delay",
        defaultValue: 0.3,
        min: 0,
        max: 1,
        step: 0.01,
      },
    },
  },
  interaction: {
    type: ControlType.Object,
    title: "Interaction",
    controls: {
      touchBehavior: {
        type: ControlType.Enum,
        title: "Touch Behavior",
        defaultValue: "drag",
        options: ["drag", "sweep", "static"],
        optionTitles: [
          "Drag to reveal",
          "Auto-sweep on scroll into view",
          "Static fill (no interaction)",
        ],
      },
      idleAnimation: {
        type: ControlType.Boolean,
        title: "Idle Animation",
        defaultValue: false,
      },
      padding: {
        type: ControlType.Padding,
        title: "Padding",
        defaultValue: "80px 40px 80px 40px",
      },
    },
  },
})
