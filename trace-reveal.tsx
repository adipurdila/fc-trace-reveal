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

type FillType = "solid" | "gradient" | "animated-gradient"
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

  // The hit area is expanded beyond the text by this much on each side via a separate
  // absolutely-positioned overlay (see hitAreaStyle below) — never via padding/margin on
  // the text's own box, so the text's layout, size, and position stay exactly as-is.
  const hitAreaPadding = useMemo(() => parsePadding(padding), [padding])

  const isCanvas = RenderTarget.current() === RenderTarget.canvas

  const containerRef = useRef<HTMLDivElement>(null)
  const hitAreaRef = useRef<HTMLDivElement>(null)
  const baseTextRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { amount: 0.4, once: false })

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

  // Fill Width mode: measure the text's natural (unscaled) single-line size — via
  // scrollWidth/Height, which `transform` never affects regardless of any previously
  // applied scale — then derive the uniform scale that makes it exactly fill the
  // container's width. Runs in a layout effect so the corrected scale is applied
  // before paint, avoiding a flash of the untransformed size. In "wrap" mode this
  // resets to a no-op (scale 1, no explicit height), leaving that behavior untouched.
  useLayoutEffect(() => {
    if (textFit !== "fill-width") {
      setFillWidthMetrics({ scale: 1, height: 0 })
      return
    }
    const el = baseTextRef.current
    if (!el || !dimensions.width) return
    const naturalWidth = el.scrollWidth
    const naturalHeight = el.scrollHeight
    if (!naturalWidth || !naturalHeight) return
    const scale = dimensions.width / naturalWidth
    setFillWidthMetrics({ scale, height: naturalHeight * scale })
  }, [
    textFit,
    dimensions.width,
    text,
    fontSize,
    letterSpacing,
    lineHeight,
    fontFamily,
    fontWeight,
    fontStyle,
  ])

  const staticTouchFill = touchBehavior === "static" && isTouchDevice

  // Pointer listeners live on the expanded hit-area overlay (not window, so multiple
  // instances on a page never steal each other's input), but coordinates are measured
  // against the text's own (unpadded) box, since that's the coordinate space the mask
  // and text layers actually render in.
  useEffect(() => {
    const hitEl = hitAreaRef.current
    const textEl = containerRef.current
    if (!hitEl || !textEl || staticTouchFill) return

    const updateFromPoint = (clientX: number, clientY: number) => {
      const rect = textEl.getBoundingClientRect()
      hasInteractedRef.current = true
      rawX.set(clientX - rect.left)
      rawY.set(clientY - rect.top)
    }

    const handlePointerMove = (event: PointerEvent) => {
      updateFromPoint(event.clientX, event.clientY)
      setIsRevealActive(true)
    }
    const handlePointerLeave = () => setIsRevealActive(false)
    const handlePointerDown = (event: PointerEvent) => {
      updateFromPoint(event.clientX, event.clientY)
      setIsRevealActive(true)
    }

    hitEl.addEventListener("pointermove", handlePointerMove)
    hitEl.addEventListener("pointerdown", handlePointerDown)
    hitEl.addEventListener("pointerleave", handlePointerLeave)
    hitEl.addEventListener("pointercancel", handlePointerLeave)
    return () => {
      hitEl.removeEventListener("pointermove", handlePointerMove)
      hitEl.removeEventListener("pointerdown", handlePointerDown)
      hitEl.removeEventListener("pointerleave", handlePointerLeave)
      hitEl.removeEventListener("pointercancel", handlePointerLeave)
    }
  }, [rawX, rawY, staticTouchFill])

  // Idle drift: only outside the canvas editor, only after a pause in real input.
  useEffect(() => {
    if (!idleAnimation || isCanvas || staticTouchFill) return
    if (!dimensions.width || !dimensions.height) return

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
    const handleActivity = () => {
      stopIdle()
      scheduleIdle()
    }

    const el = hitAreaRef.current
    el?.addEventListener("pointermove", handleActivity)
    el?.addEventListener("pointerdown", handleActivity)
    scheduleIdle()

    return () => {
      window.clearTimeout(idleTimeout)
      stopIdle()
      el?.removeEventListener("pointermove", handleActivity)
      el?.removeEventListener("pointerdown", handleActivity)
    }
  }, [idleAnimation, isCanvas, staticTouchFill, dimensions, rawX, rawY])

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

  const backgroundPositionTemplate = useMotionTemplate`${bgPosition}% 50%`

  const revealVisible = staticTouchFill || isRevealActive

  // hardness 0 = feathered gradient across the whole radius, 1 = near-hard edge.
  const innerStopPercent = clamp01(edgeHardness) * 95
  const maskImage = useMotionTemplate`radial-gradient(circle ${radius}px at ${springX}px ${springY}px, black 0%, black ${innerStopPercent}%, transparent 100%)`

  const isFillWidth = textFit === "fill-width"

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
    lineHeight: `${lineHeight}`,
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

  const fillTextStyle: CSSProperties =
    fillType === "solid"
      ? { ...sharedTextStyle, color: fillColor }
      : {
          ...sharedTextStyle,
          color: "transparent",
          backgroundImage: `linear-gradient(${gradientAngle}deg, ${fillGradientStart}, ${fillGradientEnd})`,
          backgroundClip: "text",
          WebkitBackgroundClip: "text",
          ...(fillType === "animated-gradient"
            ? { backgroundSize: "200% 200%" }
            : {}),
        }

  // Explicit height in Fill Width mode: `transform: scale()` never affects layout, so
  // without this the wrapper's auto-height would reflect the natural, unscaled text —
  // too small (or large) once actually rendered, causing it to bleed into neighboring
  // canvas content. Wrap mode is untouched (no height override, same as before).
  const rootStyle: CSSProperties = {
    position: "relative",
    display: "block",
    width: "100%",
    ...(isFillWidth && fillWidthMetrics.height > 0
      ? { height: `${fillWidthMetrics.height}px` }
      : {}),
    ...props.style,
  }

  // Absolutely-positioned overlay, offset outward by the padding amounts. It doesn't
  // contribute to rootStyle's own auto-sized box (absolute elements are out of flow),
  // so the text's layout/size/position stay exactly as if padding were 0. Painted last
  // so it sits above the text layers and can capture pointer events across its full area.
  const hitAreaStyle: CSSProperties = {
    position: "absolute",
    top: -hitAreaPadding.top,
    left: -hitAreaPadding.left,
    right: -hitAreaPadding.right,
    bottom: -hitAreaPadding.bottom,
    touchAction: touchBehavior === "drag" ? "none" : "auto",
  }

  return (
    <div ref={containerRef} style={rootStyle}>
      {/* Real, selectable, screen-reader-readable text node. */}
      <div ref={baseTextRef} style={baseTextStyle}>{text}</div>

      {/* Decorative fill layer, clipped to the reveal circle. Never part of the a11y tree. */}
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

      {/* Invisible pointer-tracking overlay, expanded beyond the text by Padding. */}
      <div ref={hitAreaRef} aria-hidden="true" style={hitAreaStyle} />
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
      font: {
        type: ControlType.Font,
        title: "Font",
        controls: "basic",
        defaultFontType: "sans-serif",
        defaultValue: { variant: "Bold" },
      },
      fontSize: {
        type: ControlType.Number,
        title: "Size",
        defaultValue: 64,
        min: 8,
        max: 300,
        step: 1,
        unit: "px",
      },
      letterSpacing: {
        type: ControlType.Number,
        title: "Letter Spacing",
        defaultValue: 0,
        min: -10,
        max: 50,
        step: 0.1,
        unit: "px",
      },
      lineHeight: {
        type: ControlType.Number,
        title: "Line Height",
        defaultValue: 1.1,
        min: 0.8,
        max: 3,
        step: 0.05,
      },
      textAlign: {
        type: ControlType.Enum,
        title: "Align",
        defaultValue: "center",
        options: ["left", "center", "right"],
        optionTitles: ["Left", "Center", "Right"],
        displaySegmentedControl: true,
      },
      textFit: {
        type: ControlType.Enum,
        title: "Text Fit",
        defaultValue: "wrap",
        options: ["wrap", "fill-width"],
        optionTitles: ["Wrap (Fixed Size)", "Fill Width (Single Line)"],
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
        options: ["solid", "gradient", "animated-gradient"],
        optionTitles: ["Solid", "Gradient", "Animated Gradient"],
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
        hidden: (props: FillGroup) => props.fillType === "solid",
      },
      fillGradientEnd: {
        type: ControlType.Color,
        title: "Gradient End",
        defaultValue: "#4ECDC4",
        hidden: (props: FillGroup) => props.fillType === "solid",
      },
      gradientAngle: {
        type: ControlType.Number,
        title: "Angle",
        defaultValue: 45,
        min: 0,
        max: 360,
        step: 1,
        unit: "deg",
        hidden: (props: FillGroup) => props.fillType === "solid",
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
